import { NextResponse } from "next/server";
import { db, getPrinter, listPrinters } from "@/lib/db";
import { probe } from "@/lib/device";
import { upsertQueue } from "@/lib/cups";
import { refreshPrinter } from "@/lib/pipeline";
import { errorResponse, printerDto, slugify } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ printers: listPrinters(true).map(printerDto) });
}

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { name?: string; uri?: string; location?: string; description?: string; isDefault?: boolean };
    if (!b.name?.trim()) return errorResponse("Name is required");
    if (!b.uri?.trim()) return errorResponse("Printer address is required");

    // Always re-probe so stored capabilities are accurate.
    const probed = await probe(b.uri);
    const id = slugify(b.name);
    const now = Date.now();
    await upsertQueue({ id, uri: probed.uri, name: b.name.trim(), location: b.location ?? "", enabled: true });

    db.transaction(() => {
      if (b.isDefault || listPrinters().length === 0) db.prepare("UPDATE printers SET is_default = 0").run();
      db.prepare(`INSERT INTO printers (id, name, uri, location, description, enabled, is_default, capabilities, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(
        id, b.name!.trim(), probed.uri, b.location ?? "", b.description ?? "",
        b.isDefault || listPrinters().length === 0 ? 1 : 0, JSON.stringify(probed.capabilities), now, now,
      );
    })();
    await refreshPrinter(id);
    return NextResponse.json({ printer: printerDto(getPrinter(id)!) });
  } catch (e) {
    return errorResponse(e);
  }
}
