import { NextResponse } from "next/server";
import {
  completeTestnetRequest, createRequest, failTestnetRequest, getRecentTestnetTransfers,
  getTestnetPolicyContext, getTestnetRequest, markTestnetOutcomeUnknown, prepareTestnetSubmission, recordTestnetRequest,
} from "@/lib/db";
import { getGuardianSignerStatus, submitGuardianRequest } from "@/lib/guardian-signer";
import { readGuardianTransferHistory } from "@/lib/near-history";
import { evaluateRequest } from "@/lib/rules";
import { verifyOwnerDecisionSignature } from "@/lib/owner-auth";
import type { NewRequestInput } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: Partial<NewRequestInput> & {
    challengeId?: string; requestId?: string; accountId?: string; publicKey?: string; signature?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const kind = body.kind;
  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const amount = typeof body.amount === "string" ? body.amount.trim() : undefined;
  if (!["transfer", "add_key", "delete_key"].includes(kind ?? "")) {
    return NextResponse.json({ error: "Choose a supported request type." }, { status: 400 });
  }
  if (!recipient || recipient.length > 128) {
    return NextResponse.json({ error: "Recipient or key label is required." }, { status: 400 });
  }
  if (kind === "transfer" && (!amount || !/^\d+(\.\d{1,24})?$/.test(amount) || Number(amount) <= 0)) {
    return NextResponse.json({ error: "Enter a positive NEAR amount." }, { status: 400 });
  }
  if (kind !== "transfer" && amount) {
    return NextResponse.json({ error: "Key requests do not use an amount." }, { status: 400 });
  }

  if (process.env.GUARDIAN_MODE === "testnet") {
    const status = getGuardianSignerStatus();
    if (!status.configured) {
      return NextResponse.json({ error: status.issue ?? `Configure testnet settings: ${status.missing.join(", ")}.` }, { status: 503 });
    }
    if (!body.challengeId || !body.requestId || !body.accountId || !body.publicKey || !body.signature) {
      return NextResponse.json({ error: "A Meteor Wallet signature for this exact request is required." }, { status: 401 });
    }
    const authorization = await verifyOwnerDecisionSignature({
      challengeId: body.challengeId,
      accountId: body.accountId,
      publicKey: body.publicKey,
      signature: body.signature,
      requestId: body.requestId,
      decision: "create",
      kind: kind as NewRequestInput["kind"],
      recipient,
      amount,
    });
    if (!authorization.ok) return NextResponse.json({ error: authorization.error }, { status: 401 });

    try {
      const accountId = status.accountId;
      if (!accountId) throw new Error("Guardian account is not configured.");
      const chainHistory = await readGuardianTransferHistory(accountId);
      const history = [...getRecentTestnetTransfers(), ...chainHistory]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const input = { kind: kind as NewRequestInput["kind"], recipient, amount };
      const evaluation = evaluateRequest(input, getTestnetPolicyContext(history));
      let created = recordTestnetRequest(input, evaluation, authorization.requestId, authorization.ownerAccountId);
      if (evaluation.held) return NextResponse.json(created, { status: 201 });
      let submissionPrepared = false;
      try {
        const sent = await submitGuardianRequest({ ...input, amount: input.amount ?? null }, (transactionHash) => {
          submissionPrepared = prepareTestnetSubmission(created.id, transactionHash);
          if (!submissionPrepared) throw new Error("Could not persist the transaction hash before broadcast; submission was stopped.");
        });
        created = completeTestnetRequest(created.id, sent.transactionHash) ?? created;
        return NextResponse.json(created, { status: 201 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "NEAR submission failed.";
        if (submissionPrepared) markTestnetOutcomeUnknown(created.id, `${getTestnetRequest(created.id)?.transactionHash ?? "hash unavailable"}. ${message}`);
        else failTestnetRequest(created.id, message);
        const latest = getTestnetRequest(created.id) ?? created;
        return NextResponse.json(latest, { status: 202 });
      }
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Could not evaluate the request against testnet data." }, { status: 503 });
    }
  }

  const created = createRequest({ kind: kind as NewRequestInput["kind"], recipient, amount });
  return NextResponse.json(created, { status: 201 });
}
