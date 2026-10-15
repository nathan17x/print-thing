import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db, UPLOAD_DIR } from "@/lib/db";
import { describeType, detectType, pdfPages } from "@/lib/convert";
import { clientId, errorResponse } from "@/lib/server";

export const runtime = "nodejs";

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return errorResponse("No file provided");
    if (file.size === 0) return errorResponse("File is empty");
    if (file.size > MAX_BYTES) return errorResponse(`File is larger than ${MAX_BYTES / 1024 / 1024} MB`);

    const id = randomUUID();
    const dir = path.join(UPLOAD_DIR, id);
    await fs.mkdir(dir, { recursive: true });
    const safeName = path.basename(file.name).replace(/[^\w.\- ()]+/g, "_").slice(-120) || "file";
    const dest = path.join(dir, safeName);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(dest, buf);

    const type = detectType(file.name, buf.subarray(0, 1024));
    const pages = type.mime === "application/pdf" ? await pdfPages(dest)
      : type.mime.startsWith("image/") ? 1 : null;

    const row = { id, name: file.name, size: file.size, mime: type.mime, kind: type.kind, pages, label: describeType(file.name, type.mime) };
    db.prepare("INSERT INTO uploads (id, client_id, name, path, size, mime, kind, pages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, await clientId(), file.name, dest, file.size, type.mime, type.kind, pages, Date.now());
    return NextResponse.json(row);
  } catch (e) {
    return errorResponse(e, 500);
  }
}
