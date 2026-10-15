import { NextResponse } from "next/server";
import { listPrinters } from "@/lib/db";
import { printerDto } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ printers: listPrinters(false).map(printerDto) });
}
