import "server-only";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { evaluateRequest, GUARDIAN_RULES } from "@/lib/rules";
import type { AuditEvent, GuardRequest, GuardianSnapshot, NewRequestInput, RequestStatus } from "@/lib/types";

const globalForDb = globalThis as typeof globalThis & { guardianDb?: Database.Database };

function openDatabase() {
  if (globalForDb.guardianDb) return globalForDb.guardianDb;
  const dbPath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(process.cwd(), "data", "guardian.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      recipient TEXT NOT NULL,
      amount TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      anomaly_score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      network_mode TEXT NOT NULL DEFAULT 'mock',
      transaction_hash TEXT,
      owner_account_id TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transfer_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL,
      network_mode TEXT NOT NULL DEFAULT 'mock',
      transaction_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_challenges (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      owner_account_id TEXT NOT NULL,
      message TEXT NOT NULL,
      nonce TEXT NOT NULL,
      recipient TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      request_kind TEXT,
      request_recipient TEXT,
      request_amount TEXT
    );
  `);
  ensureColumn(db, "requests", "network_mode", "TEXT NOT NULL DEFAULT 'mock'");
  ensureColumn(db, "requests", "transaction_hash", "TEXT");
  ensureColumn(db, "requests", "owner_account_id", "TEXT");
  ensureColumn(db, "transfer_history", "network_mode", "TEXT NOT NULL DEFAULT 'mock'");
  ensureColumn(db, "transfer_history", "transaction_hash", "TEXT");
  ensureColumn(db, "owner_challenges", "request_kind", "TEXT");
  ensureColumn(db, "owner_challenges", "request_recipient", "TEXT");
  ensureColumn(db, "owner_challenges", "request_amount", "TEXT");
  globalForDb.guardianDb = db;
  if (process.env.GUARDIAN_MODE !== "testnet") seedDatabase(db);
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function saveChallenge(input: {
  requestId: string; decision: "create" | "approve" | "deny";
  kind?: NewRequestInput["kind"]; recipient?: string; amount?: string;
}) {
  const ownerAccountId = process.env.OWNER_ACCOUNT_ID?.trim();
  if (!ownerAccountId?.endsWith(".testnet")) {
    throw new Error("Set OWNER_ACCOUNT_ID to the owner’s NEAR testnet account before using signed requests.");
  }
  const db = openDatabase();
  const id = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 5 * 60_000).toISOString();
  const recipient = process.env.GUARDIAN_APP_ID?.trim() || "guardian-dawnik";
  const nonce = randomBytes(32).toString("base64");
  const summary = input.kind === "transfer"
    ? `Kind: transfer\nRecipient: ${input.recipient}\nAmount: ${input.amount} NEAR`
    : input.kind
      ? `Kind: ${input.kind}\nPublic key: ${input.recipient}`
      : "Existing request data is fixed in the Guardian queue.";
  const authorizationScope = process.env.GUARDIAN_MODE === "testnet"
    ? "This signature authorizes only the stated request decision. The server-side Guardian signer is the only transaction signer."
    : "This signature authorizes only a mock request decision; no blockchain transaction will be sent.";
  const message = [
    "DAWNIK Guardian owner authorization",
    `Challenge: ${id}`,
    `Request: ${input.requestId}`,
    `Decision: ${input.decision}`,
    summary,
    `Expires: ${expiresAt}`,
    authorizationScope,
  ].join("\n");
  db.prepare(`INSERT INTO owner_challenges
    (id, request_id, decision, owner_account_id, message, nonce, recipient, expires_at, created_at, request_kind, request_recipient, request_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.requestId, input.decision, ownerAccountId, message, nonce, recipient, expiresAt,
      createdAt.toISOString(), input.kind ?? null, input.recipient ?? null, input.amount ?? null);
  db.prepare("DELETE FROM owner_challenges WHERE created_at < ?").run(new Date(createdAt.getTime() - 24 * 60 * 60_000).toISOString());
  return { id, requestId: input.requestId, decision: input.decision, kind: input.kind ?? null,
    requestRecipient: input.recipient ?? null, requestAmount: input.amount ?? null,
    ownerAccountId, message, nonce, recipient, expiresAt };
}

export function createOwnerRequestChallenge(input: NewRequestInput) {
  return saveChallenge({ requestId: randomUUID(), decision: "create", ...input });
}

export function createOwnerDecisionChallenge(requestId: string, decision: "approve" | "deny") {
  const db = openDatabase();
  const existing = db.prepare("SELECT kind, recipient, amount FROM requests WHERE id = ? AND status = 'pending'").get(requestId) as
    { kind: NewRequestInput["kind"]; recipient: string; amount: string | null } | undefined;
  if (!existing) return null;
  return saveChallenge({ requestId, decision, kind: existing.kind, recipient: existing.recipient, amount: existing.amount ?? undefined });
}

export function getOwnerChallenge(id: string) {
  const row = openDatabase().prepare("SELECT * FROM owner_challenges WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id), requestId: String(row.request_id), decision: row.decision as "create" | "approve" | "deny",
    ownerAccountId: String(row.owner_account_id), message: String(row.message), nonce: String(row.nonce),
    recipient: String(row.recipient), expiresAt: String(row.expires_at), usedAt: row.used_at == null ? null : String(row.used_at),
    kind: row.request_kind == null ? null : row.request_kind as NewRequestInput["kind"],
    requestRecipient: row.request_recipient == null ? null : String(row.request_recipient),
    requestAmount: row.request_amount == null ? null : String(row.request_amount),
  };
}

export function consumeOwnerChallenge(id: string, accountId: string) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const consume = db.transaction(() => {
    const result = db.prepare(`UPDATE owner_challenges SET used_at = ?
      WHERE id = ? AND owner_account_id = ? AND used_at IS NULL AND expires_at > ?`)
      .run(now, id, accountId, now);
    if (result.changes !== 1) return false;
    const challenge = db.prepare("SELECT request_id, decision FROM owner_challenges WHERE id = ?").get(id) as { request_id: string; decision: string };
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(challenge.request_id, "owner_signature_verified", `Owner ${accountId} authorized ${challenge.decision} with a NEP-413 signature.`, now);
    return true;
  });
  return consume();
}

function seedDatabase(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) as count FROM transfer_history").get() as { count: number };
  if (count.count > 0) return;
  const insertHistory = db.prepare("INSERT INTO transfer_history (recipient, amount, created_at) VALUES (?, ?, ?)");
  const history = [
    ["vendor.testnet", 0.24], ["friend.testnet", 0.18], ["vendor.testnet", 0.31],
    ["friend.testnet", 0.22], ["vendor.testnet", 0.27], ["friend.testnet", 0.35],
  ] as const;
  const seed = db.transaction(() => {
    for (const [recipient, amount] of history) {
      insertHistory.run(recipient, amount, new Date(Date.now() - 86_400_000).toISOString());
    }
    db.prepare(`INSERT INTO audit_events (request_id, action, detail, created_at)
      VALUES (NULL, 'system', 'Mock Guardian ready. Seeded wallet history is for demonstration only.', ?)`)
      .run(new Date().toISOString());
  });
  seed();
}

function mapRequest(row: Record<string, unknown>): GuardRequest {
  return {
    id: String(row.id), kind: row.kind as GuardRequest["kind"], recipient: String(row.recipient),
    amount: row.amount == null ? null : String(row.amount), status: row.status as RequestStatus,
    reason: row.reason == null ? null : String(row.reason), anomalyScore: Number(row.anomaly_score),
    transactionHash: row.transaction_hash == null ? null : String(row.transaction_hash),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapAudit(row: Record<string, unknown>): AuditEvent {
  return {
    id: Number(row.id), requestId: row.request_id == null ? null : String(row.request_id),
    action: String(row.action), detail: String(row.detail), createdAt: String(row.created_at),
  };
}

export function getSnapshot(): GuardianSnapshot {
  const db = openDatabase();
  const requests = db.prepare("SELECT * FROM requests WHERE network_mode = 'mock' ORDER BY created_at DESC LIMIT 40").all() as Record<string, unknown>[];
  const audit = db.prepare(`SELECT * FROM audit_events WHERE request_id IN
    (SELECT id FROM requests WHERE network_mode = 'mock') OR request_id IS NULL ORDER BY id DESC LIMIT 20`).all() as Record<string, unknown>[];
  const balance = (42.8 - (db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM transfer_history WHERE network_mode = 'mock'").get() as { total: number }).total).toFixed(2);
  return {
    mode: "mock",
    accountId: process.env.GUARDIAN_ACCOUNT_ID || "guardian-demo.testnet",
    balance,
    rules: { ...GUARDIAN_RULES },
    requests: requests.map(mapRequest), audit: audit.map(mapAudit),
  };
}

export function getTestnetSnapshot(balance: string, history: { recipient: string; amount: number }[]): GuardianSnapshot {
  const db = openDatabase();
  const requests = db.prepare("SELECT * FROM requests WHERE network_mode = 'testnet' ORDER BY created_at DESC LIMIT 40").all() as Record<string, unknown>[];
  const audit = db.prepare(`SELECT * FROM audit_events
    WHERE request_id IN (SELECT id FROM requests WHERE network_mode = 'testnet')
    ORDER BY id DESC LIMIT 30`).all() as Record<string, unknown>[];
  const configuredAllowlist = (process.env.TRUSTED_RECIPIENTS ?? "").split(",").map((value) => value.trim()).filter((value) => value.endsWith(".testnet"));
  const knownRecipients = [...new Set(history.map((item) => item.recipient))];
  return {
    mode: "testnet",
    accountId: process.env.GUARDIAN_ACCOUNT_ID || "unconfigured.testnet",
    balance,
    rules: { ...GUARDIAN_RULES, allowlist: configuredAllowlist },
    requests: requests.map(mapRequest), audit: audit.map(mapAudit),
    history: history.slice(0, 12).map((item) => ({ recipient: item.recipient, amount: item.amount })),
    historyCount: history.length,
    knownRecipients,
  };
}

export function getTestnetPolicyContext(history: { recipient: string; amount: number; createdAt: string; transactionHash?: string }[]) {
  const db = openDatabase();
  const since = new Date(Date.now() - GUARDIAN_RULES.burstWindowSeconds * 1_000).toISOString();
  const inFlightRequests = (db.prepare(`SELECT COUNT(*) as count FROM requests
    WHERE network_mode = 'testnet' AND kind = 'transfer' AND created_at >= ? AND status IN ('pending', 'processing')`).get(since) as { count: number }).count;
  const uniqueHistory = [...new Map(history.map((item) => [item.transactionHash ?? `${item.createdAt}:${item.recipient}:${item.amount}`, item])).values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const localRecentTransfers = (db.prepare(`SELECT COUNT(*) as count FROM transfer_history
    WHERE network_mode = 'testnet' AND created_at >= ?`).get(since) as { count: number }).count;
  const localHashes = new Set((db.prepare(`SELECT transaction_hash as transactionHash FROM transfer_history
    WHERE network_mode = 'testnet' AND transaction_hash IS NOT NULL AND created_at >= ?`).all(since) as { transactionHash: string }[])
    .map((row) => row.transactionHash));
  const indexedRecentTransfers = uniqueHistory.filter((item) => Date.parse(item.createdAt) >= Date.now() - GUARDIAN_RULES.burstWindowSeconds * 1_000 &&
    (!item.transactionHash || !localHashes.has(item.transactionHash))).length;
  const amounts = uniqueHistory.slice(0, 40).map((item) => item.amount);
  const recipients = [...new Set(uniqueHistory.map((item) => item.recipient))];
  const allowlist = (process.env.TRUSTED_RECIPIENTS ?? "").split(",").map((value) => value.trim()).filter((value) => value.endsWith(".testnet"));
  return {
    sentCountInWindow: inFlightRequests + localRecentTransfers + indexedRecentTransfers,
    historyAmounts: amounts,
    knownRecipients: recipients,
    allowlist,
  };
}

export function prepareTestnetSubmission(id: string, transactionHash: string) {
  const now = new Date().toISOString();
  const result = openDatabase().prepare(`UPDATE requests SET transaction_hash = ?, updated_at = ?, reason = ?
    WHERE id = ? AND network_mode = 'testnet' AND status = 'processing'`).run(
    transactionHash, now, "Guardian submission is awaiting final NEAR testnet confirmation.", id,
  );
  return result.changes === 1;
}

export function markTestnetOutcomeUnknown(id: string, message: string) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const detail = `Guardian submission outcome is uncertain; do not retry until transaction ${message}`.slice(0, 400);
  db.transaction(() => {
    db.prepare(`UPDATE requests SET reason = ?, updated_at = ?
      WHERE id = ? AND network_mode = 'testnet' AND status = 'processing'`).run(detail, now, id);
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, 'submission_uncertain', ?, ?)")
      .run(id, detail, now);
  })();
}

export function getRecentTestnetTransfers() {
  return openDatabase().prepare(`SELECT recipient, amount, created_at as createdAt, transaction_hash as transactionHash
    FROM transfer_history WHERE network_mode = 'testnet' ORDER BY id DESC LIMIT 100`).all() as
    { recipient: string; amount: number; createdAt: string; transactionHash?: string }[];
}

export function recordTestnetRequest(input: NewRequestInput, evaluation: ReturnType<typeof evaluateRequest>, id: string, ownerAccountId: string) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const status: RequestStatus = evaluation.held ? "pending" : "processing";
  const reason = evaluation.reasons.length ? evaluation.reasons.join(" ") : null;
  db.transaction(() => {
    db.prepare(`INSERT INTO requests
      (id, kind, recipient, amount, status, reason, anomaly_score, created_at, updated_at, network_mode, owner_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'testnet', ?)`)
      .run(id, input.kind, input.recipient, input.amount ?? null, status, reason, evaluation.anomalyScore, now, now, ownerAccountId);
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(id, evaluation.held ? "held_testnet" : "authorized_testnet", reason ?? "Owner authorized the request; deterministic rules passed. Guardian submission is starting.", now);
  })();
  return mapRequest(db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>);
}

export function getTestnetRequest(id: string) {
  const row = openDatabase().prepare("SELECT * FROM requests WHERE id = ? AND network_mode = 'testnet'").get(id) as Record<string, unknown> | undefined;
  return row ? mapRequest(row) : null;
}

export function claimTestnetRequest(id: string) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const claim = db.transaction(() => {
    const result = db.prepare(`UPDATE requests SET status = 'processing', updated_at = ?
      WHERE id = ? AND network_mode = 'testnet' AND status = 'pending'`).run(now, id);
    if (result.changes !== 1) return null;
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, 'approved_testnet', ?, ?)")
      .run(id, "Owner approved the held request. Guardian submission is starting.", now);
    return db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>;
  });
  const row = claim();
  return row ? mapRequest(row) : null;
}

export function completeTestnetRequest(id: string, transactionHash: string) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const update = db.transaction(() => {
    const current = db.prepare("SELECT kind, recipient, amount FROM requests WHERE id = ? AND network_mode = 'testnet' AND status = 'processing'").get(id) as
      { kind: string; recipient: string; amount: string | null } | undefined;
    if (!current) return null;
    db.prepare(`UPDATE requests SET status = 'sent', transaction_hash = ?, reason = NULL, updated_at = ?
      WHERE id = ? AND network_mode = 'testnet' AND status = 'processing'`).run(transactionHash, now, id);
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, 'sent_testnet', ?, ?)")
      .run(id, `Guardian submitted and confirmed transaction ${transactionHash}.`, now);
    if (current.kind === "transfer" && current.amount) {
      db.prepare(`INSERT INTO transfer_history (recipient, amount, created_at, network_mode, transaction_hash)
        VALUES (?, ?, ?, 'testnet', ?)`).run(current.recipient, Number(current.amount), now, transactionHash);
    }
    return db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>;
  });
  const row = update();
  return row ? mapRequest(row) : null;
}

export function failTestnetRequest(id: string, message: string) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const safeMessage = message.slice(0, 400);
  db.transaction(() => {
    db.prepare(`UPDATE requests SET status = 'pending', reason = ?, updated_at = ?
      WHERE id = ? AND network_mode = 'testnet' AND status = 'processing'`).run(`Guardian could not submit this request: ${safeMessage}`, now, id);
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, 'submission_failed', ?, ?)")
      .run(id, `Submission failed; request returned to review: ${safeMessage}`, now);
  })();
}

export function denyTestnetRequest(id: string) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const update = db.transaction(() => {
    const result = db.prepare(`UPDATE requests SET status = 'denied', updated_at = ?
      WHERE id = ? AND network_mode = 'testnet' AND status = 'pending'`).run(now, id);
    if (result.changes !== 1) return null;
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, 'denied_testnet', ?, ?)")
      .run(id, "Owner denied the held request. Guardian did not submit a transaction.", now);
    return db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>;
  });
  const row = update();
  return row ? mapRequest(row) : null;
}

export function createRequest(input: NewRequestInput): GuardRequest {
  const db = openDatabase();
  const now = new Date();
  const since = new Date(now.getTime() - GUARDIAN_RULES.burstWindowSeconds * 1_000).toISOString();
  const sentCount = (db.prepare("SELECT COUNT(*) as count FROM transfer_history WHERE network_mode = 'mock' AND created_at >= ?").get(since) as { count: number }).count;
  const historyAmounts = (db.prepare("SELECT amount FROM transfer_history WHERE network_mode = 'mock' ORDER BY id DESC LIMIT 40").all() as { amount: number }[]).map((row) => row.amount);
  const knownRecipients = (db.prepare("SELECT DISTINCT recipient FROM transfer_history WHERE network_mode = 'mock'").all() as { recipient: string }[]).map((row) => row.recipient);
  const evaluation = evaluateRequest(input, { sentCountInWindow: sentCount, historyAmounts, knownRecipients });
  const id = randomUUID();
  const createdAt = now.toISOString();
  const status: RequestStatus = evaluation.held ? "pending" : "sent";
  const reason = evaluation.reasons.length ? evaluation.reasons.join(" ") : null;
  const save = db.transaction(() => {
    db.prepare(`INSERT INTO requests (id, kind, recipient, amount, status, reason, anomaly_score, created_at, updated_at, network_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock')`)
      .run(id, input.kind, input.recipient, input.amount ?? null, status, reason, evaluation.anomalyScore, createdAt, createdAt);
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(id, evaluation.held ? "held" : "mock_passed", reason ?? "No guard rule triggered. The mock transaction was recorded as sent.", createdAt);
    if (!evaluation.held && input.kind === "transfer") {
      db.prepare("INSERT INTO transfer_history (recipient, amount, created_at, network_mode) VALUES (?, ?, ?, 'mock')")
        .run(input.recipient, Number(input.amount), createdAt);
    }
  });
  save();
  return mapRequest(db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>);
}

export function decideRequest(id: string, decision: "approve" | "deny"): GuardRequest | null {
  const db = openDatabase();
  const existing = db.prepare("SELECT * FROM requests WHERE id = ? AND network_mode = 'mock'").get(id) as Record<string, unknown> | undefined;
  if (!existing || existing.status !== "pending") return null;
  const now = new Date().toISOString();
  const status: RequestStatus = decision === "approve" ? "sent" : "denied";
  const detail = decision === "approve"
    ? "Approved in the mock dashboard. No blockchain transaction was sent."
    : "Denied in the mock dashboard. No blockchain transaction was sent.";
  const update = db.transaction(() => {
    db.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(status, now, id);
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(id, decision === "approve" ? "approved_mock" : "denied", detail, now);
    if (decision === "approve" && existing.kind === "transfer") {
      db.prepare("INSERT INTO transfer_history (recipient, amount, created_at, network_mode) VALUES (?, ?, ?, 'mock')")
        .run(existing.recipient, Number(existing.amount), now);
    }
  });
  update();
  return mapRequest(db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>);
}
