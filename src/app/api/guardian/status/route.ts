import { NextResponse } from "next/server";
import { getGuardianSignerStatus } from "@/lib/guardian-signer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = getGuardianSignerStatus();
  return NextResponse.json(
    {
      ...status,
      // This status endpoint only advertises configuration. It never exposes a key or sends a transaction.
      signingEnabled: false,
      message: status.configured
        ? "Guardian testnet signer is configured. Signed owner decisions are recorded as mock activity; guarded transaction submission remains disabled."
        : status.missing.length
          ? "Guardian testnet signing is selected but missing required private environment configuration."
          : "Running in mock mode. No NEAR network transactions are sent.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
