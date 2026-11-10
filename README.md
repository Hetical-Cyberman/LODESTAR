# Wallet Guardian Agent

A DAWNIK NEAR Hackathon prototype for reviewing unusual wallet requests before an owner decides what to do.

## Current V1 implementation stage

The dashboard supports mock mode and an explicitly configured testnet mode. In testnet mode, Meteor Wallet signs a one-use NEP-413 authorization tied to the exact request and decision. The server verifies the owner’s active full-access key, reads the protected account’s indexed transfer history, evaluates deterministic rules, and only then signs with the Guardian key. Safe transfers are submitted automatically after the owner authorizes the request; flagged transfers and all access-key changes wait for a second owner decision. Transaction hashes and decisions are persisted in SQLite. The owner account and Guardian account must be the same `.testnet` account, with separate owner-wallet and server-held Guardian full-access keys.

Mock mode needs no secrets. For live testnet mode, copy `.env.example` to `.env.local` and configure `GUARDIAN_MODE=testnet`, the same protected `.testnet` account in `OWNER_ACCOUNT_ID` and `GUARDIAN_ACCOUNT_ID`, a separate active Guardian `ed25519:` full-access key for the server, `FASTNEAR_API_KEY` for testnet history, and optional `TRUSTED_RECIPIENTS`. Keep `.env.local` private. Never use a mainnet key or an account holding real funds. `/api/guardian/status` never returns a key.

## Current build status

The dashboard defaults to **mock mode**. Seeded scenarios demonstrate deterministic request evaluation, hold, approve/deny, and a local SQLite audit trail. Mock approvals never send a blockchain transaction. Set the testnet environment variables in `.env.local` to enable NEAR testnet mode.

In live mode Meteor Wallet only identifies the owner and signs request or review decisions. The Guardian server is the only signer for transfers and key changes routed through this app.

## Requirements

- Node.js 20.9 or newer
- npm
- Meteor Wallet with the configured owner testnet account to sign live testnet requests and review decisions

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
- **Key change**: adding or removing an access key is always held in the mock flow.
- **Transfer burst**: rapid small requests trigger the velocity rule.

Approving a mock request records a local decision only; it does not send a blockchain transaction.

## Testnet behavior

Live mode reads up to 100 recent successful account transactions from FastNear’s testnet Transactions API, then retrieves their action details. History API failures stop new requests rather than falling back to seeded mock data. A passed transfer is signed and sent by the Guardian key. Transfers over the cap, new recipients, bursts, anomalies, and key changes stay pending until a second owner signature. The Guardian signing key cannot be deleted through this flow. If RPC confirmation is interrupted after broadcast, the request stays locked with its transaction hash so it cannot be accidentally submitted a second time. No mainnet endpoint or key is accepted.

## Protection behavior

The mock dashboard applies deterministic server-side rules:

- Amount cap: hold transfers above 5 NEAR.
- New recipient: hold a recipient missing from the demo trusted list and seeded history.
- Burst: hold a request when more than 3 requests fall within 60 seconds.
- Anomaly score: use a robust z-score when at least 4 history amounts exist; hold above 3.5.
- Key change: always hold adding or removing an access key in mock mode.

No model makes an allow/hold decision.

## Project boundary

The Guardian reviews requests routed through the dashboard; it does not monitor wallet activity in the background or protect transfers initiated elsewhere. SQLite is intended for the local prototype; hosted deployment needs persistent storage or a managed database before it can preserve its queue and audit history across instances.

## Project layout

- `src/app/page.tsx`: dashboard, mock scenarios, activity, and rules.
- `src/app/api/`: mock/testnet snapshots, owner challenges, request creation, and decision endpoints.
- `src/lib/rules.ts`: deterministic mock rule evaluation and anomaly score.
- `src/lib/near-history.ts`: FastNear testnet transfer history for risk checks.
- `src/lib/guardian-signer.ts`: testnet-only balance reads and Guardian transaction signing.
- `src/lib/db.ts`: SQLite storage, request state, and audit events.
