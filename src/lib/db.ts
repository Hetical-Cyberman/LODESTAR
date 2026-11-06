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
      updated_at TEXT NOT NULL
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
      created_at TEXT NOT NULL
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
      created_at TEXT NOT NULL
    );
  `);
  globalForDb.guardianDb = db;
  seedDatabase(db);
  return db;
}

export function createOwnerDecisionChallenge(requestId: string, decision: "approve" | "deny") {
  const ownerAccountId = process.env.OWNER_ACCOUNT_ID?.trim();
  if (!ownerAccountId?.endsWith(".testnet")) {
    throw new Error("Set OWNER_ACCOUNT_ID to the owner’s NEAR testnet account before using signed approvals.");
  }
  const db = openDatabase();
  const pending = db.prepare("SELECT id FROM requests WHERE id = ? AND status = 'pending'").get(requestId);
  if (!pending) return null;

  const id = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 5 * 60_000).toISOString();
  const recipient = process.env.GUARDIAN_APP_ID?.trim() || "guardian-dawnik";
  const nonce = randomBytes(32).toString("base64");
  const message = [
    "DAWNIK Guardian owner authorization",
    `Challenge: ${id}`,
    `Request: ${requestId}`,
    `Decision: ${decision}`,
    `Expires: ${expiresAt}`,
    "This signature authorizes only the stated mock decision; it does not sign or send a NEAR transaction.",
  ].join("\n");

  db.prepare(`INSERT INTO owner_challenges
    (id, request_id, decision, owner_account_id, message, nonce, recipient, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, requestId, decision, ownerAccountId, message, nonce, recipient, expiresAt, createdAt.toISOString());
  db.prepare("DELETE FROM owner_challenges WHERE created_at < ?").run(new Date(createdAt.getTime() - 24 * 60 * 60_000).toISOString());
  return { id, requestId, decision, ownerAccountId, message, nonce, recipient, expiresAt };
}

export function getOwnerChallenge(id: string) {
  const row = openDatabase().prepare("SELECT * FROM owner_challenges WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id), requestId: String(row.request_id), decision: row.decision as "approve" | "deny",
    ownerAccountId: String(row.owner_account_id), message: String(row.message), nonce: String(row.nonce),
    recipient: String(row.recipient), expiresAt: String(row.expires_at), usedAt: row.used_at == null ? null : String(row.used_at),
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
    const challenge = db.prepare("SELECT request_id FROM owner_challenges WHERE id = ?").get(id) as { request_id: string };
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(challenge.request_id, "owner_signature_verified", `Owner ${accountId} authorized this mock decision with a NEP-413 signature.`, now);
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
  const requests = db.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT 40").all() as Record<string, unknown>[];
  const audit = db.prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT 20").all() as Record<string, unknown>[];
  const balance = (42.8 - (db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM transfer_history").get() as { total: number }).total).toFixed(2);
  return {
    // The live signer is deliberately not wired yet. Never advertise a live mode here.
    mode: "mock",
    accountId: process.env.GUARDIAN_ACCOUNT_ID || "guardian-demo.testnet",
    balance,
    rules: { ...GUARDIAN_RULES },
    requests: requests.map(mapRequest), audit: audit.map(mapAudit),
  };
}

export function createRequest(input: NewRequestInput): GuardRequest {
  const db = openDatabase();
  const now = new Date();
  const since = new Date(now.getTime() - GUARDIAN_RULES.burstWindowSeconds * 1_000).toISOString();
  const sentCount = (db.prepare("SELECT COUNT(*) as count FROM transfer_history WHERE created_at >= ?").get(since) as { count: number }).count;
  const historyAmounts = (db.prepare("SELECT amount FROM transfer_history ORDER BY id DESC LIMIT 40").all() as { amount: number }[]).map((row) => row.amount);
  const knownRecipients = (db.prepare("SELECT DISTINCT recipient FROM transfer_history").all() as { recipient: string }[]).map((row) => row.recipient);
  const evaluation = evaluateRequest(input, { sentCountInWindow: sentCount, historyAmounts, knownRecipients });
  const id = randomUUID();
  const createdAt = now.toISOString();
  const status: RequestStatus = evaluation.held ? "pending" : "sent";
  const reason = evaluation.reasons.length ? evaluation.reasons.join(" ") : null;
  const save = db.transaction(() => {
    db.prepare(`INSERT INTO requests (id, kind, recipient, amount, status, reason, anomaly_score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.kind, input.recipient, input.amount ?? null, status, reason, evaluation.anomalyScore, createdAt, createdAt);
    db.prepare("INSERT INTO audit_events (request_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(id, evaluation.held ? "held" : "mock_passed", reason ?? "No guard rule triggered. The mock transaction was recorded as sent.", createdAt);
    if (!evaluation.held && input.kind === "transfer") {
      db.prepare("INSERT INTO transfer_history (recipient, amount, created_at) VALUES (?, ?, ?)")
        .run(input.recipient, Number(input.amount), createdAt);
    }
  });
  save();
  return mapRequest(db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>);
}

export function decideRequest(id: string, decision: "approve" | "deny"): GuardRequest | null {
  const db = openDatabase();
  const existing = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
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
      db.prepare("INSERT INTO transfer_history (recipient, amount, created_at) VALUES (?, ?, ?)")
        .run(existing.recipient, Number(existing.amount), now);
    }
  });
  update();
  return mapRequest(db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown>);
}
