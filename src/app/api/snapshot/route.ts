import { NextResponse } from "next/server";
import { getSnapshot, getTestnetSnapshot } from "@/lib/db";
import { getGuardianSignerStatus, readGuardianAccount } from "@/lib/guardian-signer";
import { readGuardianTransferHistory } from "@/lib/near-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.GUARDIAN_MODE !== "testnet") {
    return NextResponse.json(getSnapshot(), { headers: { "Cache-Control": "no-store" } });
  }
  const status = getGuardianSignerStatus();
  if (!status.configured) {
    return NextResponse.json({ ...getTestnetSnapshot("—", []), setupError: status.issue ?? `Configure: ${status.missing.join(", ")}` }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const account = await readGuardianAccount();
    const history = await readGuardianTransferHistory(account.accountId);
    return NextResponse.json(getTestnetSnapshot(account.balance, history), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ...getTestnetSnapshot("—", []),
      setupError: error instanceof Error ? error.message : "Could not load testnet Guardian account data.",
    }, { headers: { "Cache-Control": "no-store" } });
  }
}
