# Policy Contract Deployment & Interaction Guide

The V2 on-chain policy contract enforces the Guardian security policy directly on NEAR testnet.

## Contract Architecture (`contracts/guardian-policy`)
The smart contract implements:
- **`new(owner_id, guardian_id, amount_cap_near)`**: Sets owner, guardian authorized agent, and transfer cap.
- **`request_transfer(recipient, amount)`**:
  - Automatically executes if `recipient` is allowlisted AND `amount <= amount_cap`.
  - Automatically holds in a `Pending` state with explainable reasons if it exceeds cap or recipient is untrusted.
- **`approve_request(request_id)`**: Only callable by `owner_id`. Releases and sends held transfer.
- **`deny_request(request_id)`**: Only callable by `owner_id`. Drops held transfer.
- **`add_allowlist(account_id)`** / **`remove_allowlist(account_id)`**: Manage trusted recipients.
- **`set_amount_cap(amount_cap_near)`**: Change policy threshold.
- **View methods**: `get_policy`, `get_allowlist`, `get_pending_requests`, `get_request`, `get_requests`.

---

## 1. Build Contract

```bash
cd contracts/guardian-policy
cargo test
cargo build --target wasm32-unknown-unknown --release
```

Compiled WASM artifact is generated at:
`contracts/guardian-policy/target/wasm32-unknown-unknown/release/guardian_policy.wasm`

---

## 2. Deploy to NEAR Testnet

Using `near-cli` (or `near-cli-rs`):

```bash
# 1. Create or ensure testnet subaccount / account for the contract
near create-account guardian-policy.YOUR_ACCOUNT.testnet --masterAccount YOUR_ACCOUNT.testnet --initialBalance 5

# 2. Deploy contract WASM
near deploy guardian-policy.YOUR_ACCOUNT.testnet \
  contracts/guardian-policy/target/wasm32-unknown-unknown/release/guardian_policy.wasm

# 3. Initialize Contract
near call guardian-policy.YOUR_ACCOUNT.testnet new '{
  "owner_id": "YOUR_OWNER.testnet",
  "guardian_id": "YOUR_GUARDIAN.testnet",
  "amount_cap_near": 5
}' --accountId guardian-policy.YOUR_ACCOUNT.testnet
```

---

## 3. Interacting with the On-Chain Policy

### Check Policy Configuration:
```bash
near view guardian-policy.YOUR_ACCOUNT.testnet get_policy
```

### Request a Guarded Transfer (by Guardian or Owner):
```bash
near call guardian-policy.YOUR_ACCOUNT.testnet request_transfer '{
  "recipient": "new-vendor.testnet",
  "amount": "1000000000000000000000000"
}' --accountId YOUR_GUARDIAN.testnet --gas 300000000000000
```

### View Pending Held Requests:
```bash
near view guardian-policy.YOUR_ACCOUNT.testnet get_pending_requests
```

### Approve a Held Request (Owner Only):
```bash
near call guardian-policy.YOUR_ACCOUNT.testnet approve_request '{
  "request_id": 1
}' --accountId YOUR_OWNER.testnet --gas 300000000000000
```

### Deny a Held Request (Owner Only):
```bash
near call guardian-policy.YOUR_ACCOUNT.testnet deny_request '{
  "request_id": 1
}' --accountId YOUR_OWNER.testnet --gas 300000000000000
```
