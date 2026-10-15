import { NextResponse } from "next/server";
import { db, getPrinter } from "@/lib/db";
import { probe } from "@/lib/device";
import { resumeQueue, upsertQueue } from "@/lib/cups";
import { refreshPrinter } from "@/lib/pipeline";
import { errorResponse, printerDto } from "@/lib/server";

export const runtime = "nodejs";

/** Maintenance actions: refresh status, re-probe capabilities, resume a stopped queue, rebuild the CUPS queue. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const p = getPrinter(id);
    if (!p) return errorResponse("Printer not found", 404);
    const { action } = (await req.json()) as { action: "refresh" | "reprobe" | "resume" | "rebuild" };
    switch (action) {
      case "refresh":
        break;
      case "resume":
        await resumeQueue(id);
        break;
      case "reprobe":
      case "rebuild": {
        const probed = await probe(p.uri);
        db.prepare("UPDATE printers SET capabilities = ?, uri = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(probed.capabilities), probed.uri, Date.now(), id);
        if (action === "rebuild") await upsertQueue({ id, uri: probed.uri, name: p.name, location: p.location, enabled: p.enabled });
        break;
      }
      default:
        return errorResponse("Unknown action");
    }
    await refreshPrinter(id);
    return NextResponse.json({ printer: printerDto(getPrinter(id)!) });
  } catch (e) {
    return errorResponse(e);
  }
}
