import { NextResponse } from "next/server";
import { decideRequest } from "@/lib/db";
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
