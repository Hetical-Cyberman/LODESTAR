import { NextResponse } from "next/server";
import { getGuardianSignerStatus } from "@/lib/guardian-signer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = getGuardianSignerStatus();
  return NextResponse.json(
    {
      ...status,
      // Status never exposes the signing key or submits a transaction.
      signingEnabled: status.configured,
      message: status.configured
        ? "Guardian testnet signer configuration is complete. Only owner-authorized requests that pass Guardian rules can be submitted."
        : status.issue ?? (status.missing.length
          ? `Testnet configuration is incomplete: ${status.missing.join(", ")}.`
          : "Running in mock mode. No NEAR network transactions are sent."),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
