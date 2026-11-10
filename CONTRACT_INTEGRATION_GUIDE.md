# On-Chain Guardian Policy Contract (NEAR Testnet)

This guide is written for frontend and full-stack developers integrating the **V2 On-Chain Guardian Policy Smart Contract** with the Wallet Guardian UI, API routes, and agent scripts.

---

## 1. What This Smart Contract Does (The 30-Second Summary)

In V1, transaction rules and holds were simulated in a local SQLite database.  
In V2, the rules are **enforced directly by a NEAR smart contract on NEAR testnet**.

- **Safe transfers** (recipient is allowlisted AND amount $\le$ 5 NEAR): The contract executes the transfer **immediately** on-chain.
- **Risky transfers / Attacks** (amount > 5 NEAR OR recipient is not allowlisted): The contract **blocks** the transfer, locks it in a `Pending` queue on-chain, and writes a human-readable reason (e.g., `"Transfer amount 10.00 NEAR exceeds policy cap 5.00 NEAR; Recipient is not on the trusted allowlist"`).
- **Owner Authority**: Only the designated `owner_id` (via their connected wallet, like Meteor Wallet or HOT Wallet) can call `approve_request` or `deny_request`.

---

## 2. Already Deployed & Live on NEAR Testnet

A contract instance has already been deployed and tested on NEAR Testnet:
- **Contract Account ID:** `guardian-policy-482207.testnet`
- **Configured Owner Account:** `wisejaguar3455.testnet`
- **Default Policy Cap:** `5 NEAR` (`5000000000000000000000000 yoctoNEAR`)
- **NEAR Testnet Explorer:** [https://explorer.testnet.near.org/accounts/guardian-policy-482207.testnet](https://explorer.testnet.near.org/accounts/guardian-policy-482207.testnet)

---

## 3. How to Connect in Your Code (Frontend / API Routes)

### A. Environment Variables (`.env.local`)
Add the policy contract ID to your `.env.local`:

```bash
GUARDIAN_MODE=testnet
POLICY_CONTRACT_ID=guardian-policy-482207.testnet
OWNER_ACCOUNT_ID=wisejaguar3455.testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
```

---

### B. View Calls (Reading On-Chain State — No Wallet or Gas Needed)

You can call view functions from any client or server without signing a transaction or spending gas:

#### 1. Fetch Current Policy Configuration (`get_policy`)
```ts
import { JsonRpcProvider } from "near-api-js";

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });

const raw = await provider.query({
  request_type: "call_function",
  finality: "final",
  account_id: "guardian-policy-482207.testnet",
  method_name: "get_policy",
  args_base64: "",
});

const policy = JSON.parse(Buffer.from(raw.result).toString());
// Returns: { owner_id: "...", guardian_id: "...", amount_cap: "5000000000000000000000000" }
```

#### 2. Fetch Pending Held Requests (`get_pending_requests`)
```ts
const raw = await provider.query({
  request_type: "call_function",
  finality: "final",
  account_id: "guardian-policy-482207.testnet",
  method_name: "get_pending_requests",
  args_base64: "",
});

const pending = JSON.parse(Buffer.from(raw.result).toString());
// Returns array of held requests:
// [
//   {
//     id: 1,
//     recipient: "unknown-hacker.testnet",
//     amount: "10000000000000000000000000",
//     reason: "Transfer amount 10.00 NEAR exceeds policy cap...",
//     status: "Pending",
//     created_at: 1794087074780234500,
//     updated_at: 1794087074780234500
//   }
// ]
```

#### 3. Check if Recipient is Allowlisted (`is_allowlisted`)
```ts
const raw = await provider.query({
  request_type: "call_function",
  finality: "final",
  account_id: "guardian-policy-482207.testnet",
  method_name: "is_allowlisted",
  args_base64: Buffer.from(JSON.stringify({ account_id: "friend.testnet" })).toString("base64"),
});

const isTrusted = JSON.parse(Buffer.from(raw.result).toString()); // true | false
```

---

### C. Change Calls (Transactions Signed by the User / Wallet)

When the user connects their wallet (Meteor / HOT Wallet) in the UI, use the wallet selector's `signAndSendTransaction`:

#### 1. Approving a Held Request (When user clicks "Approve" in UI)
```ts
const outcome = await wallet.signAndSendTransaction({
  receiverId: "guardian-policy-482207.testnet",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "approve_request",
        args: { request_id: requestId }, // e.g. 1
        gas: "30000000000000", // 30 TGas
        deposit: "0",
      },
    },
  ],
});
```

#### 2. Denying a Held Request (When user clicks "Deny" in UI)
```ts
const outcome = await wallet.signAndSendTransaction({
  receiverId: "guardian-policy-482207.testnet",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "deny_request",
        args: { request_id: requestId },
        gas: "30000000000000",
        deposit: "0",
      },
    },
  ],
});
```

#### 3. Adding an Account to the Allowlist (Owner Settings in UI)
```ts
await wallet.signAndSendTransaction({
  receiverId: "guardian-policy-482207.testnet",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "add_allowlist",
        args: { account_id: "new-vendor.testnet" },
        gas: "30000000000000",
        deposit: "0",
      },
    },
  ],
});
```

---

### D. Server-Side Agent Calling `request_transfer`
The Guardian Agent uses `src/lib/guardian-signer.ts`:

```ts
import { requestOnChainPolicyTransfer } from "@/lib/guardian-signer";

// Submits a request to the smart contract:
const { transactionHash, outcome } = await requestOnChainPolicyTransfer({
  recipient: "friend.testnet",
  amount: "1.5", // NEAR
});
```

---

## 4. How to Test Everything Locally

You can test the contract anytime without writing custom code:

```bash
# 1. Run unit tests
cd contracts/guardian-policy
cargo test --lib

# 2. Run the live on-chain attack simulation script against testnet
cd ~/LODESTAR
node test-onchain-hold.js
```

---

## 5. Contract API Reference

| Method Name | Type | Caller | Arguments | Description |
| :--- | :--- | :--- | :--- | :--- |
| `get_policy` | View | Anyone | *None* | Returns `{ owner_id, guardian_id, amount_cap }` |
| `get_pending_requests` | View | Anyone | *None* | Returns array of all currently held requests |
| `get_allowlist` | View | Anyone | `from_index?: u64, limit?: u64` | Returns paginated list of trusted accounts |
| `is_allowlisted` | View | Anyone | `account_id: AccountId` | Returns boolean check |
| `request_transfer` | Change | Guardian/Owner | `recipient: AccountId, amount: U128` (yoctoNEAR) | Evaluates transfer; executes immediately or holds in queue |
| `approve_request` | Change | Owner only | `request_id: u64` | Releases and transfers held funds to recipient |
| `deny_request` | Change | Owner only | `request_id: u64` | Cancels and drops held request |
| `add_allowlist` | Change | Owner only | `account_id: AccountId` | Adds account to trusted allowlist |
| `remove_allowlist`| Change | Owner only | `account_id: AccountId` | Removes account from allowlist |
| `set_amount_cap` | Change | Owner only | `amount_cap_near: u128` | Updates threshold cap in whole NEAR |
