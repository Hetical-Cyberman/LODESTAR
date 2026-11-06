import "server-only";

import { verifyFullKeyBelongsToUser, verifySignature } from "@near-wallet-selector/core";
import { getOwnerChallenge, consumeOwnerChallenge } from "@/lib/db";

const TESTNET_RPC = process.env.NEAR_RPC_URL?.trim() || "https://rpc.testnet.near.org";

export async function verifyOwnerDecisionSignature(input: {
  challengeId: string;
  accountId: string;
  publicKey: string;
  signature: string;
  requestId: string;
  decision: "approve" | "deny";
}) {
  const challenge = getOwnerChallenge(input.challengeId);
  if (!challenge || challenge.usedAt || Date.parse(challenge.expiresAt) <= Date.now()) {
    return { ok: false as const, error: "This approval challenge is missing, expired, or already used." };
  }
  if (challenge.requestId !== input.requestId || challenge.decision !== input.decision) {
    return { ok: false as const, error: "The signature is for a different request or decision." };
  }
  const configuredOwner = process.env.OWNER_ACCOUNT_ID?.trim();
  if (!configuredOwner || input.accountId !== configuredOwner || input.accountId !== challenge.ownerAccountId) {
    return { ok: false as const, error: "Connect the configured owner account to authorize this request." };
  }

  try {
    const network = {
      networkId: "testnet",
      nodeUrl: TESTNET_RPC,
      helperUrl: "https://helper.testnet.near.org",
      explorerUrl: "https://explorer.testnet.near.org",
      indexerUrl: "https://indexer.testnet.near.org",
    };
    const isFullAccessKey = await verifyFullKeyBelongsToUser({
      publicKey: input.publicKey,
      accountId: input.accountId,
      network,
    });
    if (!isFullAccessKey) return { ok: false as const, error: "The signing key is not an active full access key for the configured owner." };

    const valid = verifySignature({
      publicKey: input.publicKey,
      signature: input.signature,
      message: challenge.message,
      nonce: Buffer.from(challenge.nonce, "base64"),
      recipient: challenge.recipient,
    });
    if (!valid) return { ok: false as const, error: "The owner signature does not match this request and decision." };
    if (!consumeOwnerChallenge(challenge.id, input.accountId)) {
      return { ok: false as const, error: "This challenge was already used or expired." };
    }
    return { ok: true as const, requestId: challenge.requestId, decision: challenge.decision };
  } catch {
    return { ok: false as const, error: "Could not verify the owner signature against NEAR testnet." };
  }
}
