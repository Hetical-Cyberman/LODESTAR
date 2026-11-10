import { NextResponse } from "next/server";
import {
  claimTestnetRequest, completeTestnetRequest, decideRequest, denyTestnetRequest,
  failTestnetRequest, getTestnetRequest, markTestnetOutcomeUnknown, prepareTestnetSubmission,
} from "@/lib/db";
import { getGuardianSignerStatus, submitGuardianRequest } from "@/lib/guardian-signer";
import { verifyOwnerDecisionSignature } from "@/lib/owner-auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  let body: { decision?: string; challengeId?: string; accountId?: string; publicKey?: string; signature?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (body.decision !== "approve" && body.decision !== "deny") {
    return NextResponse.json({ error: "Decision must be approve or deny." }, { status: 400 });
  }
  const { id } = await context.params;
  const isTestnet = process.env.GUARDIAN_MODE === "testnet";
  if (isTestnet) {
    const status = getGuardianSignerStatus();
    if (!status.configured) {
      return NextResponse.json({ error: status.issue ?? `Configure testnet settings: ${status.missing.join(", ")}.` }, { status: 503 });
    }
    if (!body.challengeId || !body.accountId || !body.publicKey || !body.signature) {
      return NextResponse.json({ error: "A Meteor Wallet signature for this exact decision is required." }, { status: 401 });
    }
    const authorization = await verifyOwnerDecisionSignature({
      challengeId: body.challengeId,
      accountId: body.accountId,
      publicKey: body.publicKey,
      signature: body.signature,
      requestId: id,
      decision: body.decision,
    });
    if (!authorization.ok) return NextResponse.json({ error: authorization.error }, { status: 401 });
    if (body.decision === "deny") {
      const denied = denyTestnetRequest(id);
      if (!denied) return NextResponse.json({ error: "Pending testnet request not found or already decided." }, { status: 409 });
      return NextResponse.json(denied);
    }
    const claimed = claimTestnetRequest(id);
    if (!claimed) return NextResponse.json({ error: "Pending testnet request not found or already decided." }, { status: 409 });
    let submissionPrepared = false;
    try {
      const sent = await submitGuardianRequest({ kind: claimed.kind, recipient: claimed.recipient, amount: claimed.amount }, (transactionHash) => {
        submissionPrepared = prepareTestnetSubmission(id, transactionHash);
        if (!submissionPrepared) throw new Error("Could not persist the transaction hash before broadcast; submission was stopped.");
      });
      const completed = completeTestnetRequest(id, sent.transactionHash);
      if (!completed) throw new Error("Guardian transaction was submitted, but its audit record could not be updated.");
      return NextResponse.json(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "NEAR submission failed.";
      if (submissionPrepared) markTestnetOutcomeUnknown(id, `${getTestnetRequest(id)?.transactionHash ?? "hash unavailable"}. ${message}`);
      else failTestnetRequest(id, message);
      return NextResponse.json(getTestnetRequest(id), { status: 202 });
    }
  }
  if (body.challengeId || body.accountId || body.publicKey || body.signature) {
    if (!body.challengeId || !body.accountId || !body.publicKey || !body.signature) {
      return NextResponse.json({ error: "Owner authorization is incomplete." }, { status: 400 });
    }
    const authorization = await verifyOwnerDecisionSignature({
      challengeId: body.challengeId,
      accountId: body.accountId,
      publicKey: body.publicKey,
      signature: body.signature,
      requestId: id,
      decision: body.decision,
    });
    if (!authorization.ok) return NextResponse.json({ error: authorization.error }, { status: 401 });
  }
  const updated = decideRequest(id, body.decision);
  if (!updated) {
    return NextResponse.json({ error: "Pending request not found or already decided." }, { status: 409 });
  }
  return NextResponse.json(updated);
}
