# V2 NEAR Testnet Integration

This guide documents the app's V2 transaction path and Vercel configuration.

## Deployed contract and owner

- Policy contract: `guardian-policy-482207.testnet`
- Owner: `wisejaguar3455.testnet`
- Network: NEAR testnet
- Current policy cap: read from `get_policy`; the deployed default is 5 NEAR

The contract owns the protected treasury. This app does not intercept personal wallet transfers made outside the contract.

## Request and decision flow

1. The owner connects Meteor Wallet on testnet.
2. The owner submits `request_transfer({ recipient, amount })` directly to the policy contract. Amount is a decimal string in yoctoNEAR.
3. The contract pays a transfer only when the recipient is allowlisted and the amount is within policy. Otherwise it stores the request as `Pending`.
4. The owner calls `approve_request({ request_id })` or `deny_request({ request_id })` from the configured owner account.
5. The app reads `get_requests`, `get_policy`, `get_allowlist`, and the policy contract account balance over NEAR RPC. There is no Vercel-local SQLite source of truth for testnet mode.

The app verifies that the connected account equals `wisejaguar3455.testnet`. The contract enforces that owner check again on-chain.

## Guardian agent access key

The server-side agent uses a separate testnet account. Its private key must be a NEAR **FunctionCall** access key with:

- `receiver_id`: `guardian-policy-482207.testnet`
- `method_names`: exactly `request_transfer`
- finite gas allowance: greater than zero and at most 1 NEAR

The app checks that permission through NEAR RPC and refuses FullAccess, an unexpected receiver, extra methods, or unlimited/excessive allowance. The key cannot call `approve_request`, `deny_request`, or send a direct transfer. Keep it in Vercel encrypted environment variables as `GUARDIAN_PRIVATE_KEY`; do not commit it, log it, or set it as a `NEXT_PUBLIC_` variable.

The owner must set the contract's `guardian_id` to this separate account with `set_guardian`. The dashboard provides an **Authorize Guardian account** action that sends this owner-only contract call. Confirm the displayed on-chain Guardian ID matches `GUARDIAN_ACCOUNT_ID` afterward.

## Vercel environment

Configure these server environment variables in Vercel and redeploy:

```env
GUARDIAN_MODE=testnet
POLICY_CONTRACT_ID=guardian-policy-482207.testnet
OWNER_ACCOUNT_ID=wisejaguar3455.testnet
GUARDIAN_ACCOUNT_ID=your-separate-agent.testnet
GUARDIAN_PRIVATE_KEY=ed25519:<restricted-function-call-secret>
NEAR_RPC_URL=https://rpc.testnet.near.org
```

Do not set `GUARDIAN_MODE=mock` on Vercel. Mock mode uses SQLite and is intended for local preview only. Testnet policy state is read from NEAR, avoiding ephemeral serverless file storage.

## Transfer result lifecycle

The callback-enabled contract returns `Processing` when a transfer is scheduled. A private callback then changes the request to `Executed` on successful transfer or `Failed` on a failed transfer. The UI disables request and approval actions when the deployed contract does not expose version `2.1.0`.

The Rust source includes this lifecycle, but the deployed contract must be upgraded by an authorized deployer before it takes effect on testnet. Updating the Vercel app does not upgrade contract bytecode. Never place a contract-account FullAccess key in Vercel.

## Read-only deployment check

`node deploy.js` is retained as a compatibility filename but now only reads `get_policy` and prints the owner, Guardian ID, and cap. It does not create accounts, deploy, sign transactions, or save key material.
