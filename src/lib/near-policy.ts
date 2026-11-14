import "server-only";

import { JsonRpcProvider } from "near-api-js";
import type { AuditEvent, GuardRequest, GuardianSnapshot } from "@/lib/types";

const DEFAULT_TESTNET_RPC = "https://rpc.testnet.near.org";
const OWNER_ACCOUNT_ID = "wisejaguar3455.testnet";
const YOCTO = BigInt("10") ** BigInt("24");

type ChainRequest = {
  id: number;
  recipient: string;
  amount: string;
  reason: string;
  status: "Pending" | "Processing" | "Approved" | "Denied" | "Executed" | "Failed";
  created_at: string;
  updated_at: string;
};

type Policy = { owner_id: string; guardian_id: string; amount_cap: string };

function configuration() {
  const contractId = process.env.POLICY_CONTRACT_ID?.trim() ?? "";
  const ownerId = process.env.OWNER_ACCOUNT_ID?.trim() ?? "";
  const guardianId = process.env.GUARDIAN_ACCOUNT_ID?.trim() ?? "";
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC;
  if (!contractId.endsWith(".testnet")) throw new Error("POLICY_CONTRACT_ID must be a NEAR testnet account.");
  if (ownerId !== OWNER_ACCOUNT_ID) throw new Error(`OWNER_ACCOUNT_ID must be ${OWNER_ACCOUNT_ID} for the deployed contract.`);
  if (guardianId && (!guardianId.endsWith(".testnet") || guardianId === contractId)) {
    throw new Error("GUARDIAN_ACCOUNT_ID must be a separate NEAR testnet account, not the policy contract account.");
  }
  if (!rpcUrl.startsWith("https://")) throw new Error("NEAR_RPC_URL must use HTTPS.");
  return { contractId, ownerId, guardianId, rpcUrl };
}

function provider() {
  return new JsonRpcProvider({ url: configuration().rpcUrl });
}

function decodeResult<T>(result: { result: number[] | Uint8Array }): T {
  return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
}

async function view<T>(contractId: string, methodName: string, args?: object): Promise<T> {
  const rpc = provider();
  const encoded = args ? Buffer.from(JSON.stringify(args)).toString("base64") : "";
  const result = await rpc.query({
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: encoded,
  }) as { result: number[] | Uint8Array };
  return decodeResult<T>(result);
}

function amountNear(yocto: string) {
  const value = BigInt(yocto);
  const whole = value / YOCTO;
  const fraction = (value % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function chainTime(nanoseconds: string) {
  const millis = BigInt(nanoseconds) / BigInt("1000000");
  return new Date(Number(millis)).toISOString();
}

function appStatus(status: ChainRequest["status"]): GuardRequest["status"] {
  if (status === "Pending") return "pending";
  if (status === "Processing" || status === "Approved") return "processing";
  if (status === "Denied") return "denied";
  if (status === "Failed") return "failed";
  return "sent";
}

function requestRecord(row: ChainRequest): GuardRequest {
  return {
    id: String(row.id), kind: "transfer", recipient: row.recipient,
    amount: amountNear(row.amount), status: appStatus(row.status),
    reason: row.reason || null, anomalyScore: 0,
    createdAt: chainTime(row.created_at), updatedAt: chainTime(row.updated_at),
  };
}

export async function getOnchainGuardianSnapshot(): Promise<GuardianSnapshot> {
  const config = configuration();
  const rpc = provider();
  const [policy, allowlist, account, contractVersion] = await Promise.all([
    view<Policy>(config.contractId, "get_policy"),
    view<string[]>(config.contractId, "get_allowlist", { from_index: 0, limit: 100 }),
    rpc.query({ request_type: "view_account", finality: "final", account_id: config.contractId }) as Promise<{ amount: string }>,
    view<string>(config.contractId, "get_contract_version").catch(() => null),
  ]);
  let requests: ChainRequest[];
  try {
    const requestCount = await view<number>(config.contractId, "get_request_count");
    requests = await view<ChainRequest[]>(config.contractId, "get_requests", {
      from_index: Math.max(0, requestCount - 100), limit: 100,
    });
  } catch {
    // Earlier V2 deployments expose only the pending queue, not the V2.1 history views.
    requests = await view<ChainRequest[]>(config.contractId, "get_pending_requests");
  }

  if (policy.owner_id !== config.ownerId) {
    throw new Error(`The deployed policy owner is ${policy.owner_id}, but OWNER_ACCOUNT_ID is ${config.ownerId}.`);
  }
  const mapped = requests.map(requestRecord).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const audit: AuditEvent[] = mapped.slice(0, 30).map((request, index) => ({
    id: index + 1, requestId: request.id,
    action: `onchain_${request.status}`,
    detail: `${request.kind === "transfer" ? "Transfer" : "Request"} ${request.id}: ${request.reason ?? request.status}.`,
    createdAt: request.updatedAt,
  }));
  return {
    mode: "testnet", accountId: config.contractId, ownerAccountId: config.ownerId,
    guardianAccountId: config.guardianId || policy.guardian_id, contractGuardianId: policy.guardian_id,
    contractVersion, callbackReady: contractVersion === "2.1.0",
    balance: amountNear(account.amount),
    rules: {
      amountCap: Number(amountNear(policy.amount_cap)), burstLimit: 0,
      burstWindowSeconds: 0, anomalyZScore: 0, allowlist,
    },
    requests: mapped, audit,
  };
}

export function getPolicyConnectionConfig() {
  return configuration();
}
