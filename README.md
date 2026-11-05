# Wallet Guardian Agent

A DAWNIK NEAR Hackathon prototype for pausing unusual wallet requests until an owner reviews them.

## Current build status

The current implementation is a **local mock prototype**. It demonstrates the request evaluation, hold, approve/deny, and audit flow using seeded wallet history. It does not connect to NEAR, sign transactions, or move funds. The interface labels this mode and every mock approval is recorded as mock activity.

V1 scope is native NEAR transfer requests and guarded key-change requests. Fungible tokens, NFTs, contract calls, Telegram approvals, and the on-chain policy contract are outside the current mock build.

## Requirements

- Node.js 20.9 or newer
- npm

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The first API request creates `data/guardian.sqlite` and seeds demonstration history. No environment variables, wallet keys, or network access are needed for mock mode.

To use a different local SQLite path, copy `.env.example` to `.env.local` and set `DATABASE_PATH`. Keep `.env.local` private. The database is ignored by Git.

## Try the demo

- **Normal payment**: a small transfer to a trusted recipient passes the configured rules and is recorded as mock activity.
- **Large transfer**: an 82 NEAR request is held because it exceeds the 5 NEAR cap.
- **New recipient**: a first-time recipient request is held for review.
- **Key change**: adding an access key is always held in the mock flow.
- **Transfer burst**: four rapid small requests trigger the velocity rule on the request over the configured limit.

Approve or deny a held request from the dashboard. Decisions are persisted in SQLite and appear in the audit trail. “Approve” means approved in the mock simulation; it does not send a blockchain transaction.

## Protection behavior

The demo applies deterministic rules on the server:

- Amount cap: hold transfers above 5 NEAR.
- New recipient: hold a recipient missing from the trusted list and wallet history.
- Burst: hold a request when more than 3 requests fall within 60 seconds.
- Anomaly score: use a robust z-score when at least 4 history amounts exist; hold above 3.5.
- Key change: always hold adding or removing an access key.

The rules in this prototype are fixed in `src/lib/rules.ts`. Natural-language explanation is currently generated from rule results; no model makes the allow/hold decision.

## Important implementation boundary

The Guardian can only pause requests that pass through its own signing path. Reading transaction history after a wallet has broadcast a transaction cannot stop that transfer. The current build has no signer, so it makes no claim to protect a live account. Testnet integration must use a dedicated demo account, a clearly scoped signer, and owner approval tied to the specific pending request. Never use a mainnet key for this prototype.

SQLite is intended for the local prototype. A hosted deployment needs persistent storage or a managed database before it can preserve its queue and audit history across instances.

## Project layout

- `src/app/page.tsx`: dashboard, demo controls, activity, rules.
- `src/app/api/`: snapshot, request creation, and decision endpoints.
- `src/lib/rules.ts`: deterministic rule evaluation and anomaly score.
- `src/lib/db.ts`: SQLite storage, seed data, request state, and audit events.
