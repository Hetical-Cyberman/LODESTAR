import "server-only";

import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";

const DEFAULT_TESTNET_RPC = "https://rpc.testnet.near.org";
const OWNER_ACCOUNT_ID = "wisejaguar3455.testnet";
const YOCTO_PER_NEAR = BigInt("10") ** BigInt("24");
const ALLOWED_AGENT_METHODS = ["request_transfer"];

type GuardianSignerConfig = {
  accountId: string;
  contractId: string;
  ownerId: string;
  rpcUrl: string;
  privateKey: string;
};

export type GuardianSignerStatus = {
  configured: boolean;
  network: "testnet";
  accountId: string | null;
  policyContractId: string | null;
  ownerAccountId: string;
  rpcUrl: string;
  missing: string[];
  issue?: string;
};

export function isTestnetAccountId(value: string) {
  return /^[a-z0-9._-]{2,64}$/.test(value) && value.endsWith(".testnet");
}

export function validateEd25519PublicKey(value: string) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,46}$/.test(value)) {
    throw new Error("Enter an ed25519 NEAR public key beginning with ed25519:.");
  }
}

function readConfig(): GuardianSignerConfig | null {
  if (process.env.GUARDIAN_MODE !== "testnet") return null;
  const accountId = process.env.GUARDIAN_ACCOUNT_ID?.trim() ?? "";
  const contractId = process.env.POLICY_CONTRACT_ID?.trim() ?? "";
  const ownerId = process.env.OWNER_ACCOUNT_ID?.trim() ?? "";
  const privateKey = process.env.GUARDIAN_PRIVATE_KEY?.trim() ?? "";
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC;
  if (!accountId.endsWith(".testnet") || accountId === contractId) {
    throw new Error("GUARDIAN_ACCOUNT_ID must be a separate NEAR testnet account, not the policy contract account.");
  }
  if (!contractId.endsWith(".testnet")) throw new Error("POLICY_CONTRACT_ID must be a NEAR testnet account.");
  if (ownerId !== OWNER_ACCOUNT_ID) throw new Error(`OWNER_ACCOUNT_ID must be ${OWNER_ACCOUNT_ID} for the deployed policy contract.`);
  if (!privateKey.startsWith("ed25519:")) throw new Error("GUARDIAN_PRIVATE_KEY must be a restricted ed25519 function-call key.");
  if (!rpcUrl.startsWith("https://")) throw new Error("NEAR_RPC_URL must use HTTPS.");
  return { accountId, contractId, ownerId, rpcUrl, privateKey };
}

export function getGuardianSignerStatus(): GuardianSignerStatus {
  const mode = process.env.GUARDIAN_MODE === "testnet";
  const missing: string[] = [];
  if (mode && !process.env.POLICY_CONTRACT_ID?.trim()) missing.push("POLICY_CONTRACT_ID");
  if (mode && !process.env.OWNER_ACCOUNT_ID?.trim()) missing.push("OWNER_ACCOUNT_ID");
  if (mode && !process.env.GUARDIAN_ACCOUNT_ID?.trim()) missing.push("GUARDIAN_ACCOUNT_ID");
  if (mode && !process.env.GUARDIAN_PRIVATE_KEY?.trim()) missing.push("GUARDIAN_PRIVATE_KEY");
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC;
  const policyContractId = process.env.POLICY_CONTRACT_ID?.trim() || null;
  if (!mode) return {
    configured: false, network: "testnet", accountId: null, policyContractId,
    ownerAccountId: OWNER_ACCOUNT_ID, rpcUrl, missing: [],
  };
  let issue: string | undefined;
  if (!missing.length) {
    try { readConfig(); } catch (error) { issue = error instanceof Error ? error.message : "Testnet configuration is invalid."; }
  }
  return {
    configured: missing.length === 0 && !issue, network: "testnet",
    accountId: process.env.GUARDIAN_ACCOUNT_ID?.trim() || null,
    policyContractId, ownerAccountId: OWNER_ACCOUNT_ID, rpcUrl, missing,
    ...(issue ? { issue } : {}),
  };
}

function guardianContext() {
  const config = readConfig();
  if (!config) throw new Error("NEAR testnet Guardian signer is not configured.");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const keyPair = KeyPair.fromString(config.privateKey as KeyPairString);
  return { config, provider, keyPair };
}

/** Enforces that the server secret cannot authorize transfers or arbitrary calls. */
export async function verifyGuardianFunctionCallKey() {
  const { config, provider, keyPair } = guardianContext();
  const accessKey = await provider.query({
    request_type: "view_access_key", account_id: config.accountId, finality: "final",
    public_key: keyPair.getPublicKey().toString(),
  }) as { permission?: unknown };
  const permission = accessKey.permission as { FunctionCall?: {
    allowance?: string | null; receiver_id?: string; method_names?: string[];
  } } | undefined;
  const call = permission?.FunctionCall;
  if (!call) throw new Error("The server key is not a function-call key. Remove any full-access key from Vercel.");
  if (call.receiver_id !== config.contractId) throw new Error("The server key must be restricted to POLICY_CONTRACT_ID as its receiver.");
  const methods = call.method_names ?? [];
  if (methods.length !== ALLOWED_AGENT_METHODS.length || methods[0] !== ALLOWED_AGENT_METHODS[0]) {
    throw new Error("The server key must allow only the request_transfer method.");
  }
  if (!call.allowance || BigInt(call.allowance) <= BigInt("0") || BigInt(call.allowance) > YOCTO_PER_NEAR) {
    throw new Error("The server function-call key must have a finite allowance no greater than 1 NEAR.");
  }
  return { accountId: config.accountId, publicKey: keyPair.getPublicKey().toString(), receiverId: call.receiver_id, methodNames: methods };
}

export async function requestOnChainPolicyTransfer(input: { recipient: string; amount: string }) {
  if (!/^[a-z0-9._-]{2,64}$/.test(input.recipient) || !input.recipient.endsWith(".testnet")) {
    throw new Error("Recipient must be a valid NEAR testnet account.");
  }
  if (!/^\d+(\.\d{1,24})?$/.test(input.amount) || !Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) {
    throw new Error("Enter a positive NEAR amount with up to 24 decimal places.");
  }
  await verifyGuardianFunctionCallKey();
  const { config, provider, keyPair } = guardianContext();
  const account = new Account(config.accountId, provider, keyPair.toString() as KeyPairString);
  const outcome = await account.callFunctionRaw({
    contractId: config.contractId,
    methodName: "request_transfer",
    args: { recipient: input.recipient, amount: nearToYocto(input.amount as `${number}`).toString() },
    gas: BigInt("50000000000000"),
    deposit: BigInt(0),
  });
  return { transactionHash: outcome.transaction?.hash, outcome };
}
