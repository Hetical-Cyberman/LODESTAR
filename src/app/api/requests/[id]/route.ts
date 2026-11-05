import { NextResponse } from "next/server";
import { decideRequest } from "@/lib/db";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
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
  const updated = decideRequest(id, body.decision);
  if (!updated) {
    return NextResponse.json({ error: "Pending request not found or already decided." }, { status: 409 });
  }
  return NextResponse.json(updated);
}
