# Wallet Guardian Agent

A DAWNIK NEAR Hackathon prototype for reviewing unusual wallet requests before an owner decides what to do.

## Current V1 implementation stage

The dashboard and request API are still mock-only: approval and “sent” status are local SQLite records and do not broadcast transactions. HOT Wallet can sign a short-lived, one-time NEP-413 challenge bound to a pending request and the selected decision. The server checks that the signer is an active full-access key for `OWNER_ACCOUNT_ID`, then records the verified signature in the local audit trail. This currently authorizes only a mock decision; it does not create or send a NEAR transaction. The Guardian signer module is prepared for a dedicated testnet account but is not connected to request execution.

To try signed mock decisions, copy `.env.example` to `.env.local` and set `OWNER_ACCOUNT_ID` to the expected owner’s NEAR testnet account. To prepare the separate Guardian signer, set its testnet account and dedicated testnet-only `ed25519:` secret key, and optionally the RPC URL. Never commit `.env.local`, use a mainnet key, or use an account holding real funds. `/api/guardian/status` reports signer configuration only; it never returns the secret or submits a transaction.

## Current build status

The dashboard and its seeded scenarios run in **mock mode**. They demonstrate deterministic request evaluation, hold, approve/deny, and a local SQLite audit trail. Mock approvals never send a blockchain transaction.

The V1 signing design uses HOT Wallet only to identify the owner and sign Guardian review decisions. The Guardian server will be the only transaction signer when guarded testnet submission is implemented. Direct owner-wallet transfers are not presented as guarded transfers.

## Requirements

- Node.js 20.9 or newer
- npm
- HOT Wallet with the configured owner testnet account to sign a mock review decision

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

## Protection behavior

The mock dashboard applies deterministic server-side rules:

- Amount cap: hold transfers above 5 NEAR.
- New recipient: hold a recipient missing from the demo trusted list and seeded history.
- Burst: hold a request when more than 3 requests fall within 60 seconds.
- Anomaly score: use a robust z-score when at least 4 history amounts exist; hold above 3.5.
- Key change: always hold adding or removing an access key in mock mode.

No model makes an allow/hold decision.

## Project boundary

The mock Guardian reviews requests routed through the dashboard; it does not monitor wallet activity in the background or protect transfers initiated elsewhere. The configured Guardian testnet signer is not connected to request execution yet. SQLite is intended for the local prototype; hosted deployment needs persistent storage or a managed database before it can preserve its queue and audit history across instances.

## Project layout

- `src/app/page.tsx`: dashboard, mock scenarios, activity, and rules.
- `src/app/api/`: mock snapshot, request creation, and decision endpoints.
- `src/lib/rules.ts`: deterministic mock rule evaluation and anomaly score.
- `src/lib/db.ts`: SQLite storage, mock seed data, request state, and audit events.
