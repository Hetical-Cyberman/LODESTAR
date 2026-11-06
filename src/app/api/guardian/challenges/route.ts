import { NextResponse } from "next/server";
import { createOwnerDecisionChallenge } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { requestId?: unknown; decision?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof body.requestId !== "string" || body.requestId.length > 100 ||
      (body.decision !== "approve" && body.decision !== "deny")) {
    return NextResponse.json({ error: "Choose a pending request and an approve or deny decision." }, { status: 400 });
  }
  try {
    const challenge = createOwnerDecisionChallenge(body.requestId, body.decision);
    if (!challenge) return NextResponse.json({ error: "Pending request not found or already decided." }, { status: 409 });
    return NextResponse.json(challenge, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create owner challenge." }, { status: 503 });
  }
}
