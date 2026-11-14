# Guardian | NEAR Wallet Protection

Guardian is a NEAR Testnet policy console. In V2, contract storage is the source of truth for policy settings, the allowlist, transfer requests, and outcomes. The connected owner wallet submits requests and signs approve/deny and policy-management calls. The deployed policy contract is `guardian-policy-482207.testnet`; its owner is `wisejaguar3455.testnet`.

## V2 transaction model

- The policy contract holds the NEAR treasury. Transfers are sent from the contract account, not from a user's personal Meteor Wallet balance.
- The contract immediately schedules a transfer only when the recipient is allowlisted and the amount is within the cap. Other requests remain on-chain as `Pending` until the owner approves or denies them.
- The UI uses Meteor Wallet to call `request_transfer`, `approve_request`, `deny_request`, `add_allowlist`, `remove_allowlist`, and `set_guardian` on the contract.
- `Processing` remains visible until the contract's private callback records `Executed` or `Failed` after NEAR resolves the transfer promise.
- Contract request IDs and final statuses come from NEAR RPC. Local SQLite is for the local preview only; Vercel testnet mode does not rely on a local database.
- This protects only funds held by the policy contract and calls routed through it. It does not monitor or protect transfers sent directly from personal wallets.

## Configure testnet locally or on Vercel

Copy `.env.example` to `.env.local` for local development, or add these variables in Vercel Project Settings → Environment Variables. Set them for the deployment environment and redeploy after editing:

```env
GUARDIAN_MODE=testnet
POLICY_CONTRACT_ID=guardian-policy-482207.testnet
OWNER_ACCOUNT_ID=wisejaguar3455.testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
GUARDIAN_ACCOUNT_ID=your-separate-agent.testnet
GUARDIAN_PRIVATE_KEY=ed25519:<restricted-function-call-secret>
```

`GUARDIAN_ACCOUNT_ID` must be a separate testnet account. The configured key must be an active **FunctionCall** access key on that account, restricted to receiver `guardian-policy-482207.testnet`, method `request_transfer` only, with a finite allowance no greater than 1 NEAR. The server rejects full-access keys and keys with a broader permission. Store the secret only in local `.env.local` or Vercel's encrypted environment settings; never commit it or put it in a `NEXT_PUBLIC_` variable.

The deployed contract currently has its own account as `guardian_id`. After configuring the agent account and starting the app, connect `wisejaguar3455.testnet` and choose **Authorize Guardian account**. This calls the contract's owner-only `set_guardian` method. The dashboard displays the current contract Guardian so you can confirm it matches.

Fund the policy contract account separately with testnet NEAR before trying transfers. The server agent account also needs a small balance for function-call gas. Use only testnet funds.

## Contract deployment and callback update

The Rust source has been updated to report `Processing` first and record `Executed`/`Failed` from the transfer callback. The currently deployed contract must be upgraded by an authorized contract deployer before that callback behavior is live on-chain. This repository does not deploy or upgrade the contract automatically. Do not put a contract-account full-access key in Vercel.

`deploy.js` is now a read-only verification script; it no longer creates accounts, broadcasts deployments, or writes private keys. Contract upgrades must be done by the authorized deployer using a secure local signing method, after reviewing the Rust change and building the WASM.

## Run locally

```bash
npm install
npm run dev
```

Use `GUARDIAN_MODE=mock` only for a local interface preview. Sample scenarios and SQLite records are not on-chain. For Vercel, configure `GUARDIAN_MODE=testnet`; production refuses mock-only storage.

## Verification commands

```bash
npm run typecheck
npm run build
cd contracts/guardian-policy
cargo test --lib
cargo test --test test_lifecycle
```

The lifecycle test requires the `wasm32-unknown-unknown` target and a working NEAR Sandbox setup. Before using Vercel, confirm its variables are set and the contract's on-chain `owner_id`, `guardian_id`, policy cap, and treasury balance are correct.
