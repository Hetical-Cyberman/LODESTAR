use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedSet, Vector};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
};
use serde::{Deserialize, Serialize};

/// Status of a transaction held in the guardian approval queue.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub enum RequestStatus {
    Pending,
    Approved,
    Denied,
    Executed,
    // Keep newly introduced variants after the original statuses: Borsh encodes
    // enum variants by index, and existing on-chain requests must retain meaning.
    Processing,
    Failed,
}

/// A request record stored in the queue.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct QueuedRequest {
    pub id: u64,
    pub recipient: AccountId,
    pub amount: U128,
    pub reason: String,
    pub status: RequestStatus,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Policy configuration parameters.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct PolicyConfig {
    pub owner_id: AccountId,
    pub guardian_id: AccountId,
    /// Transfer amount limit in yoctoNEAR (e.g., 5 NEAR) above which a transfer must be held.
    pub amount_cap: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct GuardianPolicyContract {
    pub owner_id: AccountId,
    pub guardian_id: AccountId,
    pub amount_cap: NearToken,
    pub allowlist: UnorderedSet<AccountId>,
    pub requests: Vector<QueuedRequest>,
    pub request_by_id: LookupMap<u64, QueuedRequest>,
    pub next_request_id: u64,
}

#[near]
impl GuardianPolicyContract {
    #[init]
    pub fn new(owner_id: AccountId, guardian_id: AccountId, amount_cap_near: u128) -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self {
            owner_id,
            guardian_id,
            amount_cap: NearToken::from_near(amount_cap_near),
            allowlist: UnorderedSet::new(b"a"),
            requests: Vector::new(b"r"),
            request_by_id: LookupMap::new(b"m"),
            next_request_id: 1,
        }
    }

    pub fn get_contract_version(&self) -> String {
        "2.1.0".to_string()
    }

    /// Helper assertion ensuring caller is owner.
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only owner can call this method"
        );
    }

    /// Helper assertion ensuring caller is owner or authorized guardian.
    fn assert_authorized(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || caller == self.guardian_id,
            "Unauthorized caller"
        );
    }

    // --- Policy & Allowlist Management (Owner only) ---

    pub fn set_amount_cap(&mut self, amount_cap_near: u128) {
        self.assert_owner();
        self.amount_cap = NearToken::from_near(amount_cap_near);
    }

    pub fn set_guardian(&mut self, guardian_id: AccountId) {
        self.assert_owner();
        self.guardian_id = guardian_id;
    }

    pub fn add_allowlist(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.allowlist.insert(&account_id);
    }

    pub fn remove_allowlist(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&account_id);
    }

    // --- Transfer & Queue Operations ---

    /// Evaluates transfer against policies:
    /// 1. If recipient is allowlisted AND amount <= amount_cap: submits immediately.
    /// 2. If above cap or not allowlisted: places into pending queue with reason.
    pub fn request_transfer(&mut self, recipient: AccountId, amount: U128) -> QueuedRequest {
        self.assert_authorized();
        require!(amount.0 > 0, "Transfer amount must be greater than zero");
        let token_amount = NearToken::from_yoctonear(amount.0);
        let is_allowlisted = self.allowlist.contains(&recipient);
        let exceeds_cap = token_amount > self.amount_cap;

        if is_allowlisted && !exceeds_cap {
            let req = QueuedRequest {
                id: self.next_request_id,
                recipient: recipient.clone(),
                amount,
                reason: "Within amount cap and allowlisted".to_string(),
                status: RequestStatus::Processing,
                created_at: env::block_timestamp(),
                updated_at: env::block_timestamp(),
            };
            self.requests.push(&req);
            self.request_by_id.insert(&self.next_request_id, &req);
            self.schedule_transfer(req.id, recipient, token_amount);
            self.next_request_id += 1;
            return req;
        }

        // Flagged: calculate plain language reasons
        let mut reasons = Vec::new();
        if exceeds_cap {
            reasons.push(format!(
                "Transfer amount {} exceeds policy cap {}",
                token_amount, self.amount_cap
            ));
        }
        if !is_allowlisted {
            reasons.push("Recipient is not on the trusted allowlist".to_string());
        }

        let req = QueuedRequest {
            id: self.next_request_id,
            recipient,
            amount,
            reason: reasons.join("; "),
            status: RequestStatus::Pending,
            created_at: env::block_timestamp(),
            updated_at: env::block_timestamp(),
        };

        self.requests.push(&req);
        self.request_by_id.insert(&self.next_request_id, &req);
        self.next_request_id += 1;
        req
    }

    /// Owner approves a held pending request, scheduling the transfer.
    pub fn approve_request(&mut self, request_id: u64) -> QueuedRequest {
        self.assert_owner();
        let mut req = self
            .request_by_id
            .get(&request_id)
            .expect("Request not found");
        require!(req.status == RequestStatus::Pending, "Request is not pending");

        let token_amount = NearToken::from_yoctonear(req.amount.0);
        req.status = RequestStatus::Processing;
        req.updated_at = env::block_timestamp();
        self.request_by_id.insert(&request_id, &req);

        self.update_request_in_vector(&req);

        self.schedule_transfer(req.id, req.recipient.clone(), token_amount);

        req
    }

    fn schedule_transfer(&self, request_id: u64, recipient: AccountId, amount: NearToken) {
        let callback_args = near_sdk::serde_json::to_vec(&serde_json::json!({ "request_id": request_id }))
            .expect("callback args serialize");
        let _transfer = Promise::new(recipient)
            .transfer(amount)
            .then(Promise::new(env::current_account_id()).function_call(
                "on_transfer_complete".to_string(),
                callback_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            ));
    }

    /// Finalizes the request only after the NEAR transfer receipt resolves.
    #[private]
    pub fn on_transfer_complete(&mut self, request_id: u64) -> QueuedRequest {
        let mut req = self.request_by_id.get(&request_id).expect("Request not found");
        require!(req.status == RequestStatus::Processing, "Request is not processing");
        req.status = match env::promise_result_checked(0, 0) {
            Ok(_) => RequestStatus::Executed,
            Err(_) => RequestStatus::Failed,
        };
        req.updated_at = env::block_timestamp();
        self.request_by_id.insert(&request_id, &req);
        self.update_request_in_vector(&req);
        req
    }

    fn update_request_in_vector(&mut self, req: &QueuedRequest) {
        let index = req.id.saturating_sub(1);
        if index < self.requests.len() {
            self.requests.replace(index, req);
        }
    }

    /// Owner denies a held pending request.
    pub fn deny_request(&mut self, request_id: u64) -> QueuedRequest {
        self.assert_owner();
        let mut req = self
            .request_by_id
            .get(&request_id)
            .expect("Request not found");
        require!(req.status == RequestStatus::Pending, "Request is not pending");

        req.status = RequestStatus::Denied;
        req.updated_at = env::block_timestamp();
        self.request_by_id.insert(&request_id, &req);

        self.update_request_in_vector(&req);

        req
    }

    // --- View Methods ---

    pub fn get_policy(&self) -> PolicyConfig {
        PolicyConfig {
            owner_id: self.owner_id.clone(),
            guardian_id: self.guardian_id.clone(),
            amount_cap: U128(self.amount_cap.as_yoctonear()),
        }
    }

    pub fn get_allowlist(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<AccountId> {
        let start = from_index.unwrap_or(0);
        let max = limit.unwrap_or(50);
        self.allowlist.iter().skip(start as usize).take(max as usize).collect()
    }

    pub fn is_allowlisted(&self, account_id: AccountId) -> bool {
        self.allowlist.contains(&account_id)
    }

    pub fn get_request(&self, request_id: u64) -> Option<QueuedRequest> {
        self.request_by_id.get(&request_id)
    }

    pub fn get_request_count(&self) -> u64 {
        self.requests.len()
    }

    pub fn get_requests(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<QueuedRequest> {
        let total = self.requests.len();
        let start = from_index.unwrap_or(0);
        let max = limit.unwrap_or(50);
        (start..std::cmp::min(start + max, total))
            .filter_map(|i| self.requests.get(i))
            .collect()
    }

    pub fn get_pending_requests(&self) -> Vec<QueuedRequest> {
        let mut pending = Vec::new();
        for i in 0..self.requests.len() {
            if let Some(r) = self.requests.get(i) {
                if r.status == RequestStatus::Pending {
                    pending.push(r);
                }
            }
        }
        pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn get_context(predecessor: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(predecessor);
        builder
    }

    #[test]
    fn test_initialization() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let guardian: AccountId = "guardian.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());

        let contract = GuardianPolicyContract::new(owner.clone(), guardian.clone(), 5);
        let policy = contract.get_policy();
        assert_eq!(policy.owner_id, owner);
        assert_eq!(policy.guardian_id, guardian);
        assert_eq!(policy.amount_cap.0, NearToken::from_near(5).as_yoctonear());
    }

    #[test]
    fn test_allowlist_management() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let guardian: AccountId = "guardian.testnet".parse().unwrap();
        let vendor: AccountId = "vendor.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());

        let mut contract = GuardianPolicyContract::new(owner.clone(), guardian, 5);
        assert!(!contract.is_allowlisted(vendor.clone()));

        contract.add_allowlist(vendor.clone());
        assert!(contract.is_allowlisted(vendor.clone()));

        contract.remove_allowlist(vendor.clone());
        assert!(!contract.is_allowlisted(vendor.clone()));
    }

    #[test]
    fn test_request_transfer_holds_unauthorized_recipient() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let guardian: AccountId = "guardian.testnet".parse().unwrap();
        let unknown: AccountId = "unknown.testnet".parse().unwrap();

        let context = get_context(guardian.clone());
        testing_env!(context.build());

        let mut contract = GuardianPolicyContract::new(owner.clone(), guardian.clone(), 5);

        // 1 NEAR to unknown recipient (not allowlisted) -> should be held as Pending
        let one_near = U128(NearToken::from_near(1).as_yoctonear());
        let req = contract.request_transfer(unknown.clone(), one_near);

        assert_eq!(req.status, RequestStatus::Pending);
        assert!(req.reason.contains("allowlist"));

        let pending = contract.get_pending_requests();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, req.id);
    }

    #[test]
    fn test_owner_approve_held_request() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let guardian: AccountId = "guardian.testnet".parse().unwrap();
        let unknown: AccountId = "unknown.testnet".parse().unwrap();

        // 1. Guardian requests transfer
        let mut context = get_context(guardian.clone());
        testing_env!(context.build());

        let mut contract = GuardianPolicyContract::new(owner.clone(), guardian.clone(), 5);
        let req = contract.request_transfer(unknown.clone(), U128(NearToken::from_near(10).as_yoctonear()));
        assert_eq!(req.status, RequestStatus::Pending);

        // 2. Owner approves
        testing_env!(context.predecessor_account_id(owner.clone()).build());
        let approved = contract.approve_request(req.id);
        assert_eq!(approved.status, RequestStatus::Processing);
        assert_eq!(contract.get_pending_requests().len(), 0);
    }

    #[test]
    fn test_owner_deny_held_request() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let guardian: AccountId = "guardian.testnet".parse().unwrap();
        let unknown: AccountId = "unknown.testnet".parse().unwrap();

        let mut context = get_context(guardian.clone());
        testing_env!(context.build());

        let mut contract = GuardianPolicyContract::new(owner.clone(), guardian.clone(), 5);
        let req = contract.request_transfer(unknown.clone(), U128(NearToken::from_near(10).as_yoctonear()));
        assert_eq!(req.status, RequestStatus::Pending);

        testing_env!(context.predecessor_account_id(owner.clone()).build());
        let denied = contract.deny_request(req.id);
        assert_eq!(denied.status, RequestStatus::Denied);
        assert_eq!(contract.get_pending_requests().len(), 0);
    }
}
