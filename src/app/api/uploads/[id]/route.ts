import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db, getUpload } from "@/lib/db";
import { clientId } from "@/lib/server";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = getUpload(id);
  if (!u || u.clientId !== (await clientId())) return NextResponse.json({ ok: true });
  // Keep files that already have print jobs; the cleanup task removes them later.
  const used = db.prepare("SELECT 1 FROM jobs WHERE upload_id = ?").get(id);
  if (!used) {
    await fs.rm(path.dirname(u.path), { recursive: true, force: true }).catch(() => {});
    db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
  }
  return NextResponse.json({ ok: true });
}
