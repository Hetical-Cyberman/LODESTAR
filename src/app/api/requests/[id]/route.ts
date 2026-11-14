import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (process.env.GUARDIAN_MODE === "testnet") {
    return NextResponse.json({ error: "For testnet, approve or deny requests directly through the connected owner wallet." }, { status: 409 });
  }
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Mock request storage is available locally only. Configure GUARDIAN_MODE=testnet for Vercel." }, { status: 503 });
  }
  let body: { decision?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (body.decision !== "approve" && body.decision !== "deny") {
    return NextResponse.json({ error: "Decision must be approve or deny." }, { status: 400 });
  }
  const { id } = await context.params;
  const { decideRequest } = await import("@/lib/db");
  const updated = decideRequest(id, body.decision);
  if (!updated) {
    return NextResponse.json({ error: "Pending request not found or already decided." }, { status: 409 });
  }
  return NextResponse.json(updated);
}
