import "server-only";

import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";

const DEFAULT_TESTNET_RPC = "https://rpc.testnet.near.org";

export type GuardianSignerConfig = {
  accountId: string;
  rpcUrl: string;
  privateKey: string;
  policyContractId?: string;
};

export type GuardianSignerStatus = {
  configured: boolean;
  network: "testnet";
  accountId: string | null;
  policyContractId: string | null;
  rpcUrl: string;
  missing: string[];
};

function readConfig(): GuardianSignerConfig | null {
  if (process.env.GUARDIAN_MODE !== "testnet") return null;

  const accountId = process.env.GUARDIAN_ACCOUNT_ID?.trim() ?? "";
  const privateKey = process.env.GUARDIAN_PRIVATE_KEY?.trim() ?? "";
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC;
  const policyContractId = process.env.POLICY_CONTRACT_ID?.trim();

  if (!accountId.endsWith(".testnet")) {
    throw new Error("GUARDIAN_ACCOUNT_ID must be a NEAR testnet account ending in .testnet.");
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

  return { accountId, privateKey, rpcUrl, policyContractId };
}

export function getGuardianSignerStatus(): GuardianSignerStatus {
  const mode = process.env.GUARDIAN_MODE === "testnet";
  const missing: string[] = [];
  if (mode && !process.env.GUARDIAN_ACCOUNT_ID?.trim()) missing.push("GUARDIAN_ACCOUNT_ID");
  if (mode && !process.env.GUARDIAN_PRIVATE_KEY?.trim()) missing.push("GUARDIAN_PRIVATE_KEY");
  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC;
  const policyContractId = process.env.POLICY_CONTRACT_ID?.trim() || null;

  if (!mode) {
    return { configured: false, network: "testnet", accountId: null, policyContractId: null, rpcUrl, missing: [] };
  }

  if (!missing.length) readConfig();
  return {
    configured: missing.length === 0,
    network: "testnet",
    accountId: process.env.GUARDIAN_ACCOUNT_ID?.trim() || null,
    policyContractId,
    rpcUrl,
    missing,
  };
}

function getGuardianAccount() {
  const config = readConfig();
  if (!config) throw new Error("Guardian testnet signing is not enabled.");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const keyPair = KeyPair.fromString(config.privateKey as KeyPairString);
  return new Account(config.accountId, provider, keyPair.toString() as KeyPairString);
}

/** Sends a native NEAR transfer from the configured Guardian account.
 * Call only after the server has evaluated the request and verified owner authorization.
 */
export async function sendGuardianTransfer(input: { recipient: string; amount: string }) {
  const account = getGuardianAccount();
  const amount = Number(input.amount);
  if (!/^\d+(\.\d{1,24})?$/.test(input.amount) || !Number.isFinite(amount) || amount <= 0 || amount > 5) {
    throw new Error("Transfer amount must be positive and at or below the 5 NEAR V1 cap.");
  }
  if (!/^[a-z0-9._-]{2,64}$/.test(input.recipient) || !input.recipient.endsWith(".testnet")) {
    throw new Error("Recipient must be a valid NEAR testnet account.");
  }

  const result = await account.transfer({ receiverId: input.recipient, amount: nearToYocto(input.amount as `${number}`) });
  const transactionHash = result.transaction?.hash;
  if (!transactionHash) throw new Error("NEAR RPC returned no transaction hash.");
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
