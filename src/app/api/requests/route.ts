import { NextResponse } from "next/server";
import { createRequest } from "@/lib/db";
import type { NewRequestInput } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: Partial<NewRequestInput>;
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

  const created = createRequest({ kind: kind as NewRequestInput["kind"], recipient, amount });
  return NextResponse.json(created, { status: 201 });
}
