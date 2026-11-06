# Wallet Guardian Agent

A DAWNIK NEAR Hackathon prototype for reviewing unusual wallet requests before an owner decides what to do.

## Current build status

The dashboard and its seeded scenarios run in **mock mode**. They demonstrate deterministic request evaluation, hold, approve/deny, and a local SQLite audit trail. Mock approvals never send a blockchain transaction.

The overview also includes an optional **NEAR testnet transfer panel**. It connects through NEAR Wallet Selector and checks a manually entered native NEAR transfer against the demo amount cap and sample trusted-recipient list. A request stays in the browser until you approve it in Guardian; the connected wallet then presents the transaction for its own signature. Nothing is broadcast before that wallet approval.

This testnet panel is a signing-path demonstration, not live wallet protection. It checks only transfers entered in the panel, uses demo rules rather than live wallet history, and does not persist the transfer review to the SQLite audit trail. It cannot pause transactions started in another app or stop a transaction after broadcast. Use a disposable testnet account only. Never connect a mainnet account for this prototype.

Key changes, fungible tokens, NFTs, contract calls, Telegram approvals, and the on-chain policy contract are not part of the testnet signing flow.

## Requirements

- Node.js 20.9 or newer
- npm
- A NEAR wallet with a testnet account to try the optional testnet panel

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The first API request creates `data/guardian.sqlite` and seeds mock history. No wallet, environment variables, or network access are needed to use the dashboard and mock scenarios.

To use a different local SQLite path, copy `.env.example` to `.env.local` and set `DATABASE_PATH`. Keep `.env.local` private. The database is ignored by Git.

## Try the mock dashboard

- **Normal payment**: a small transfer to a trusted recipient passes the configured rules and is recorded as mock activity.
- **Large transfer**: an 82 NEAR request is held because it exceeds the 5 NEAR cap.
- **New recipient**: a first-time recipient request is held for review.
- **Key change**: adding an access key is always held in the mock flow.
- **Transfer burst**: rapid small requests trigger the velocity rule.

Approving a mock request records a local decision only; it does not send a blockchain transaction.

## Try the optional testnet transfer panel

1. Connect a disposable NEAR testnet account using MyNearWallet.
2. Enter a `.testnet` recipient and a positive NEAR amount.
3. Review the request and its demo-rule result.
4. Choose **Approve & send**, then review and approve the transaction in your wallet.

A new recipient or amount above 5 NEAR is flagged for review. The account owner remains the signer and the wallet confirmation is required. Canceling the review does not send anything.

## Protection behavior

The mock dashboard applies deterministic server-side rules:

- Amount cap: hold transfers above 5 NEAR.
- New recipient: hold a recipient missing from the demo trusted list and seeded history.
- Burst: hold a request when more than 3 requests fall within 60 seconds.
- Anomaly score: use a robust z-score when at least 4 history amounts exist; hold above 3.5.
- Key change: always hold adding or removing an access key in mock mode.

The optional testnet panel currently applies only the amount cap and demo trusted-recipient check in the browser. No model makes an allow/hold decision.

## Project boundary

The Guardian can only review transfers that a user enters through its own testnet panel. This prototype does not monitor an account in the background or protect transfers initiated elsewhere. Testnet transactions use the connected account's own wallet signer and still require wallet approval. SQLite is intended for the local mock prototype; hosted deployment needs persistent storage or a managed database before it can preserve its mock queue and audit history across instances.

## Project layout

- `src/app/page.tsx`: dashboard, mock scenarios, activity, and rules.
- `src/app/testnet-wallet.tsx`: optional testnet wallet connection and transfer review/signing path.
- `src/app/api/`: mock snapshot, request creation, and decision endpoints.
- `src/lib/rules.ts`: deterministic mock rule evaluation and anomaly score.
- `src/lib/db.ts`: SQLite storage, mock seed data, request state, and audit events.
