import "server-only";

import { createHash } from "node:crypto";
import { Account, actions, baseEncode, JsonRpcProvider, KeyPair, nearToYocto, PublicKey, type KeyPairString } from "near-api-js";

const DEFAULT_TESTNET_RPC = "https://rpc.testnet.near.org";

export type GuardianSignerConfig = {
  accountId: string;
  rpcUrl: string;
  privateKey: string;
  policyContractId?: string;
  fastNearApiKey: string;
};

export type GuardianSignerStatus = {
  configured: boolean;
  network: "testnet";
  accountId: string | null;
  policyContractId: string | null;
  rpcUrl: string;
  missing: string[];
  issue?: string;
};

function readConfig(): GuardianSignerConfig | null {
  if (process.env.GUARDIAN_MODE !== "testnet") return null;

  const accountId = process.env.GUARDIAN_ACCOUNT_ID?.trim() ?? "";
  const ownerAccountId = process.env.OWNER_ACCOUNT_ID?.trim() ?? "";
  const privateKey = process.env.GUARDIAN_PRIVATE_KEY?.trim() ?? "";
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC;
  const policyContractId = process.env.POLICY_CONTRACT_ID?.trim();
  const fastNearApiKey = process.env.FASTNEAR_API_KEY?.trim() ?? "";

  if (!accountId.endsWith(".testnet")) {
    throw new Error("GUARDIAN_ACCOUNT_ID must be a NEAR testnet account ending in .testnet.");
  }
  if (ownerAccountId !== accountId) {
    throw new Error("OWNER_ACCOUNT_ID must match GUARDIAN_ACCOUNT_ID so the owner and Guardian protect the same account.");
  }
  if (!privateKey.startsWith("ed25519:")) {
    throw new Error("GUARDIAN_PRIVATE_KEY must be an ed25519 NEAR secret key.");
  }
  if (!rpcUrl.startsWith("https://")) {
    throw new Error("NEAR_RPC_URL must use HTTPS.");
  }
  if (policyContractId && !policyContractId.endsWith(".testnet")) {
    throw new Error("POLICY_CONTRACT_ID must be a valid NEAR testnet account.");
  }
  if (!fastNearApiKey) throw new Error("FASTNEAR_API_KEY is required to load real testnet account history.");

  return { accountId, privateKey, rpcUrl, policyContractId, fastNearApiKey };
}

export function getGuardianSignerStatus(): GuardianSignerStatus {
  const mode = process.env.GUARDIAN_MODE === "testnet";
  const missing: string[] = [];
  if (mode && !process.env.GUARDIAN_ACCOUNT_ID?.trim()) missing.push("GUARDIAN_ACCOUNT_ID");
  if (mode && !process.env.GUARDIAN_PRIVATE_KEY?.trim()) missing.push("GUARDIAN_PRIVATE_KEY");
  if (mode && !process.env.OWNER_ACCOUNT_ID?.trim()) missing.push("OWNER_ACCOUNT_ID");
  if (mode && !process.env.FASTNEAR_API_KEY?.trim()) missing.push("FASTNEAR_API_KEY");
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC;
  const policyContractId = process.env.POLICY_CONTRACT_ID?.trim() || null;

  if (!mode) {
    return { configured: false, network: "testnet", accountId: null, policyContractId: null, rpcUrl, missing: [] };
  }

  let issue: string | undefined;
  if (!missing.length) {
    try { readConfig(); } catch (error) { issue = error instanceof Error ? error.message : "Testnet configuration is invalid."; }
  }
  return {
    configured: missing.length === 0 && !issue,
    network: "testnet",
    accountId: process.env.GUARDIAN_ACCOUNT_ID?.trim() || null,
    policyContractId,
    rpcUrl,
    missing,
    ...(issue ? { issue } : {}),
  };
}

function getGuardianConfig() {
  const config = readConfig();
  if (!config) throw new Error("Guardian testnet signing is not enabled.");
  return config;
}

function getGuardianProvider() {
  const config = getGuardianConfig();
  return new JsonRpcProvider({ url: config.rpcUrl });
}

function getGuardianAccount() {
  const config = getGuardianConfig();
  const provider = getGuardianProvider();
  const keyPair = KeyPair.fromString(config.privateKey as KeyPairString);
  return new Account(config.accountId, provider, keyPair.toString() as KeyPairString);
}

export async function readGuardianAccount() {
  const config = getGuardianConfig();
  const provider = getGuardianProvider();
  const keyPair = KeyPair.fromString(config.privateKey as KeyPairString);
  const publicKey = keyPair.getPublicKey().toString();
  const accessKey = await provider.query({
    request_type: "view_access_key",
    account_id: config.accountId,
    finality: "final",
    public_key: publicKey,
  }) as { permission?: string; nonce?: number };
  if (accessKey.permission !== "FullAccess") {
    throw new Error("The Guardian signing key is not an active full access key on the configured account.");
  }
  const account = new Account(config.accountId, provider, keyPair.toString() as KeyPairString);
  const balance = await account.getBalance();
  return {
    accountId: config.accountId,
    publicKey,
    balance: formatYoctoNear(balance),
    rpcUrl: config.rpcUrl,
  };
}

function formatYoctoNear(value: bigint) {
  const unit = BigInt(10) ** BigInt(24);
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(24, "0").slice(0, 2);
  return `${whole}.${fraction}`;
}

export async function submitGuardianRequest(
  input: { kind: "transfer" | "add_key" | "delete_key"; recipient: string; amount: string | null },
  onPrepared?: (transactionHash: string) => void,
) {
  const state = await readGuardianAccount();
  const account = getGuardianAccount();
  let receiverId = state.accountId;
  let action;
  if (input.kind === "transfer") {
    const amount = Number(input.amount);
    if (!input.amount || !/^\d+(\.\d{1,24})?$/.test(input.amount) || !Number.isFinite(amount) || amount <= 0 || amount > 5) {
      throw new Error("Transfer amount must be positive and at or below the 5 NEAR V1 cap.");
    }
    if (!isTestnetAccountId(input.recipient)) throw new Error("Recipient must be a valid NEAR testnet account.");
    receiverId = input.recipient;
    action = actions.transfer(nearToYocto(input.amount as `${number}`));
  } else if (input.kind === "add_key") {
    validateEd25519PublicKey(input.recipient);
    action = actions.addFullAccessKey(PublicKey.fromString(input.recipient));
  } else {
    validateEd25519PublicKey(input.recipient);
    if (input.recipient === state.publicKey) throw new Error("The Guardian’s own signing key cannot be removed.");
    action = actions.deleteKey(PublicKey.fromString(input.recipient));
  }
  const signed = await account.createSignedTransaction({ receiverId, actions: [action] });
  const transactionHash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
  onPrepared?.(transactionHash);
  const result = await account.provider.sendTransactionUntil(signed, "FINAL");
  if (typeof result.status === "object" && "Failure" in result.status) {
    throw new Error(`NEAR transaction failed: ${JSON.stringify(result.status.Failure).slice(0, 240)}`);
  }
  return { transactionHash, result };
}

/** Requests a transfer via the on-chain policy contract.
 * If within limits and allowlisted, the contract executes the transfer;
 * otherwise it queues the request on-chain in Pending status.
 */
export async function requestOnChainPolicyTransfer(input: { recipient: string; amount: string }) {
  const config = readConfig();
  if (!config?.policyContractId) {
    throw new Error("POLICY_CONTRACT_ID must be configured to call on-chain policy.");
  }
  const account = getGuardianAccount();
  const yocto = nearToYocto(input.amount as `${number}`);

  const outcome = await account.callFunctionRaw({
    contractId: config.policyContractId,
    methodName: "request_transfer",
    args: {
      recipient: input.recipient,
      amount: yocto.toString(),
    },
    gas: BigInt("30000000000000"), // 30 Tgas
    deposit: BigInt(0),
  });

  return {
    transactionHash: outcome.transaction?.hash,
    outcome,
  };
}

export function isTestnetAccountId(value: string) {
  return /^[a-z0-9._-]{2,64}$/.test(value) && value.endsWith(".testnet");
}

export function validateEd25519PublicKey(value: string) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,46}$/.test(value)) {
    throw new Error("Enter an ed25519 NEAR public key beginning with ed25519:.");
  }
}

/* Guarded transaction submission is called only after an owner signature and policy evaluation. */
export async function sendGuardianTransfer(input: { recipient: string; amount: string }) {
  return submitGuardianRequest({ kind: "transfer", recipient: input.recipient, amount: input.amount });
}
