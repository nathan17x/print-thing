import { NextResponse } from "next/server";
import { db, getPrinter } from "@/lib/db";
import { probe } from "@/lib/device";
import { deleteQueue, updateQueueMeta, upsertQueue } from "@/lib/cups";
import { refreshPrinter, state } from "@/lib/pipeline";
import { errorResponse, printerDto } from "@/lib/server";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const p = getPrinter(id);
    if (!p) return errorResponse("Printer not found", 404);
    const b = (await req.json()) as { name?: string; uri?: string; location?: string; description?: string; enabled?: boolean; isDefault?: boolean };

    const next = {
      name: b.name?.trim() || p.name,
      location: b.location ?? p.location,
      description: b.description ?? p.description,
      enabled: b.enabled ?? p.enabled,
      uri: p.uri,
      capabilities: p.capabilities,
    };

    const uriChanged = b.uri !== undefined && b.uri.trim() !== p.uri;
    if (uriChanged || (next.enabled && !p.enabled)) {
      const probed = await probe(b.uri?.trim() || p.uri);
      next.uri = probed.uri;
      next.capabilities = probed.capabilities;
    }
    if (uriChanged || next.enabled !== p.enabled) {
      await upsertQueue({ id, uri: next.uri, name: next.name, location: next.location, enabled: next.enabled });
    } else if (next.name !== p.name || next.location !== p.location) {
      await updateQueueMeta({ id, name: next.name, location: next.location });
    }

    db.transaction(() => {
      if (b.isDefault) db.prepare("UPDATE printers SET is_default = 0").run();
      db.prepare(`UPDATE printers SET name = ?, uri = ?, location = ?, description = ?, enabled = ?, capabilities = ?,
        is_default = COALESCE(?, is_default), updated_at = ? WHERE id = ?`).run(
        next.name, next.uri, next.location, next.description, next.enabled ? 1 : 0, JSON.stringify(next.capabilities),
        b.isDefault === undefined ? null : b.isDefault ? 1 : 0, Date.now(), id,
      );
    })();
    if (next.enabled) await refreshPrinter(id);
    return NextResponse.json({ printer: printerDto(getPrinter(id)!) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    await deleteQueue(id);
    db.prepare("DELETE FROM printers WHERE id = ?").run(id);
    delete state.device[id];
    delete state.queue[id];
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
