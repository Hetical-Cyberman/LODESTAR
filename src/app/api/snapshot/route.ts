import { NextResponse } from "next/server";
import { GUARDIAN_RULES } from "@/lib/rules";
import { getOnchainGuardianSnapshot } from "@/lib/near-policy";
import type { GuardianSnapshot } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.GUARDIAN_MODE !== "testnet") {
    if (process.env.VERCEL) return NextResponse.json({ error: "Production must run with GUARDIAN_MODE=testnet." }, { status: 503 });
    const { getSnapshot } = await import("@/lib/db");
    return NextResponse.json(getSnapshot(), { headers: { "Cache-Control": "no-store" } });
  }
  try {
    return NextResponse.json(await getOnchainGuardianSnapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ...emptyTestnetSnapshot(),
      setupError: error instanceof Error ? error.message : "Could not load testnet Guardian account data.",
    }, { headers: { "Cache-Control": "no-store" } });
  }
}

function emptyTestnetSnapshot(setupError?: string): GuardianSnapshot {
  return {
    mode: "testnet", accountId: process.env.POLICY_CONTRACT_ID || "unconfigured.testnet",
    ownerAccountId: process.env.OWNER_ACCOUNT_ID || "wisejaguar3455.testnet",
    guardianAccountId: process.env.GUARDIAN_ACCOUNT_ID || "unconfigured.testnet",
    contractVersion: null, callbackReady: false,
    balance: "—", rules: { ...GUARDIAN_RULES, allowlist: [] }, requests: [], audit: [],
    ...(setupError ? { setupError } : {}),
  };
}
