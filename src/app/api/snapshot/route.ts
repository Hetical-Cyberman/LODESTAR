import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
