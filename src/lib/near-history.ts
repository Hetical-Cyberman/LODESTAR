import "server-only";

export type NearTransferHistoryRow = { recipient: string; amount: number; createdAt: string; transactionHash: string };

const BASE_URL = "https://tx.test.fastnear.com";

function toIsoTimestamp(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return new Date().toISOString();
  const source = String(value);
  if (!/^\d+$/.test(source)) {
    const parsed = new Date(source);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  const raw = Number(source);
  const millis = raw > 1e15 ? raw / 1e6 : raw > 1e12 ? raw / 1e3 : raw * 1e3;
  return new Date(millis).toISOString();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const apiKey = process.env.FASTNEAR_API_KEY?.trim();
  if (!apiKey) throw new Error("FASTNEAR_API_KEY is required to read Guardian account history.");
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`FastNear history request failed (${response.status}).`);
  return await response.json() as T;
}

function txObject(entry: Record<string, unknown>) {
  const outer = entry.transaction as Record<string, unknown> | undefined;
  const nested = outer?.transaction as Record<string, unknown> | undefined;
  return nested ?? outer ?? entry;
}

function transferActionAmount(value: unknown): bigint | null {
  if (!value || typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  const transfer = (action.Transfer ?? action.transfer) as Record<string, unknown> | undefined;
  const amount = transfer?.deposit ?? transfer?.amount;
  if (typeof amount !== "string" && typeof amount !== "number") return null;
  try { return BigInt(amount); } catch { return null; }
}

export async function readGuardianTransferHistory(accountId: string): Promise<NearTransferHistoryRow[]> {
  if (!accountId.endsWith(".testnet")) throw new Error("History reads are restricted to a NEAR testnet account.");
  const accountHistory = await post<{ account_txs?: Record<string, unknown>[] }>("/v0/account", {
    account_id: accountId,
    desc: true,
    is_signer: true,
    is_success: true,
    limit: 100,
  });
  if (!Array.isArray(accountHistory.account_txs)) throw new Error("FastNear returned an unexpected account-history response.");
  const accountRows = accountHistory.account_txs;
  const hashes = accountRows.map((row) => row.transaction_hash).filter((value): value is string => typeof value === "string");
  const entries: Record<string, unknown>[] = [];
  for (let start = 0; start < hashes.length; start += 20) {
    const result = await post<{ transactions?: Record<string, unknown>[] }>("/v0/transactions", { tx_hashes: hashes.slice(start, start + 20) });
    if (!Array.isArray(result.transactions)) throw new Error("FastNear returned an unexpected transaction-history response.");
    entries.push(...result.transactions);
  }

  const historyByHash = new Map(accountRows.map((row) => [String(row.transaction_hash), row]));
  const result: NearTransferHistoryRow[] = [];
  for (const entry of entries) {
    const transaction = txObject(entry);
    if (transaction.signer_id !== accountId || !Array.isArray(transaction.actions)) continue;
    const hash = typeof transaction.hash === "string" ? transaction.hash : "";
    const accountRow = historyByHash.get(hash);
    const timestamp = toIsoTimestamp(accountRow?.tx_block_timestamp);
    for (const action of transaction.actions) {
      const yoctoAmount = transferActionAmount(action);
      if (yoctoAmount === null || typeof transaction.receiver_id !== "string") continue;
      const nearAmount = Number(yoctoAmount) / 1e24;
      if (!Number.isFinite(nearAmount) || nearAmount <= 0) continue;
      result.push({ recipient: transaction.receiver_id, amount: nearAmount, createdAt: timestamp, transactionHash: hash });
    }
  }
  return result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100);
}
