import { NextResponse } from "next/server";
import { getGuardianSignerStatus, verifyGuardianFunctionCallKey } from "@/lib/guardian-signer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = getGuardianSignerStatus();
  let keyIssue: string | undefined;
  if (status.configured) {
    try { await verifyGuardianFunctionCallKey(); }
    catch (error) { keyIssue = error instanceof Error ? error.message : "Guardian function-call key is invalid."; }
  }
  const configured = status.configured && !keyIssue;
  return NextResponse.json(
    {
      ...status,
      configured,
      // Status never exposes the signing key or submits a transaction.
      signingEnabled: configured,
      message: configured
        ? "The server key is restricted to request_transfer on the configured policy contract."
        : keyIssue ?? status.issue ?? (status.missing.length
          ? `Testnet configuration is incomplete: ${status.missing.join(", ")}.`
          : "Running in mock mode. No NEAR network transactions are sent."),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
