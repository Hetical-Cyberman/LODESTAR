import { NextResponse } from "next/server";
import { createOwnerDecisionChallenge, createOwnerRequestChallenge } from "@/lib/db";
import { isTestnetAccountId, validateEd25519PublicKey } from "@/lib/guardian-signer";
import type { NewRequestInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { requestId?: unknown; decision?: unknown; kind?: unknown; recipient?: unknown; amount?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  try {
    if (body.decision === "create") {
      const kind = body.kind;
      const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
      const amount = typeof body.amount === "string" ? body.amount.trim() : undefined;
      if (!(["transfer", "add_key", "delete_key"] as unknown[]).includes(kind)) {
        return NextResponse.json({ error: "Choose a supported testnet request type." }, { status: 400 });
      }
      if (kind === "transfer" && (!isTestnetAccountId(recipient) || !amount ||
          !/^\d+(\.\d{1,24})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 1_000_000)) {
        return NextResponse.json({ error: "Enter a valid .testnet recipient and positive NEAR amount." }, { status: 400 });
      }
      if (kind !== "transfer") {
        try { validateEd25519PublicKey(recipient); } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : "Enter a valid ed25519 public key." }, { status: 400 });
        }
        if (amount) return NextResponse.json({ error: "Key requests do not use an amount." }, { status: 400 });
      }
      const challenge = createOwnerRequestChallenge({ kind: kind as NewRequestInput["kind"], recipient, amount });
      return NextResponse.json(challenge, { headers: { "Cache-Control": "no-store" } });
    }
    if (typeof body.requestId !== "string" || body.requestId.length > 100 ||
        (body.decision !== "approve" && body.decision !== "deny")) {
      return NextResponse.json({ error: "Choose a pending request and an approve or deny decision." }, { status: 400 });
    }
    const challenge = createOwnerDecisionChallenge(body.requestId, body.decision);
    if (!challenge) return NextResponse.json({ error: "Pending request not found or already decided." }, { status: 409 });
    return NextResponse.json(challenge, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create owner challenge." }, { status: 503 });
  }
}
