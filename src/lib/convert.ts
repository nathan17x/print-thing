import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FileKind = "native" | "office" | "image-convert" | "svg" | "unsupported";

interface TypeInfo { mime: string; kind: FileKind; label: string }

const EXT: Record<string, TypeInfo> = {
  pdf: { mime: "application/pdf", kind: "native", label: "PDF" },
  ps: { mime: "application/postscript", kind: "native", label: "PostScript" },
  eps: { mime: "application/postscript", kind: "native", label: "PostScript" },
  jpg: { mime: "image/jpeg", kind: "native", label: "JPEG image" },
  jpeg: { mime: "image/jpeg", kind: "native", label: "JPEG image" },
  png: { mime: "image/png", kind: "native", label: "PNG image" },
  gif: { mime: "image/gif", kind: "native", label: "GIF image" },
  tif: { mime: "image/tiff", kind: "native", label: "TIFF image" },
  tiff: { mime: "image/tiff", kind: "native", label: "TIFF image" },
  pnm: { mime: "image/x-portable-anymap", kind: "native", label: "PNM image" },
  txt: { mime: "text/plain", kind: "native", label: "Text" },
  text: { mime: "text/plain", kind: "native", label: "Text" },
  log: { mime: "text/plain", kind: "native", label: "Text" },
  md: { mime: "text/plain", kind: "native", label: "Markdown (as text)" },
  bmp: { mime: "image/bmp", kind: "image-convert", label: "BMP image" },
  webp: { mime: "image/webp", kind: "image-convert", label: "WebP image" },
  heic: { mime: "image/heic", kind: "image-convert", label: "HEIC photo" },
  heif: { mime: "image/heif", kind: "image-convert", label: "HEIF photo" },
  avif: { mime: "image/avif", kind: "image-convert", label: "AVIF image" },
  svg: { mime: "image/svg+xml", kind: "svg", label: "SVG" },
  doc: { mime: "application/msword", kind: "office", label: "Word" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "office", label: "Word" },
  odt: { mime: "application/vnd.oasis.opendocument.text", kind: "office", label: "OpenDocument text" },
  rtf: { mime: "application/rtf", kind: "office", label: "Rich text" },
  xls: { mime: "application/vnd.ms-excel", kind: "office", label: "Excel" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "office", label: "Excel" },
  ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", kind: "office", label: "OpenDocument sheet" },
  csv: { mime: "text/csv", kind: "office", label: "CSV" },
  ppt: { mime: "application/vnd.ms-powerpoint", kind: "office", label: "PowerPoint" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "office", label: "PowerPoint" },
  odp: { mime: "application/vnd.oasis.opendocument.presentation", kind: "office", label: "OpenDocument slides" },
  odg: { mime: "application/vnd.oasis.opendocument.graphics", kind: "office", label: "OpenDocument drawing" },
  html: { mime: "text/html", kind: "office", label: "Web page" },
  htm: { mime: "text/html", kind: "office", label: "Web page" },
  xps: { mime: "application/oxps", kind: "unsupported", label: "XPS" },
};

export const ACCEPT_EXTENSIONS = Object.entries(EXT).filter(([, v]) => v.kind !== "unsupported").map(([k]) => `.${k}`);

export function detectType(fileName: string, head: Buffer): TypeInfo {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (EXT[ext]) return EXT[ext];
  // Sniff magic bytes for files without a useful extension.
  if (head.subarray(0, 5).toString() === "%PDF-") return EXT.pdf;
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return EXT.png;
  if (head[0] === 0xff && head[1] === 0xd8) return EXT.jpg;
  if (head.subarray(0, 2).toString() === "%!") return EXT.ps;
  if (head.subarray(0, 4).toString() === "PK\x03\x04") return { ...EXT.docx, label: "Office document (zip)" };
  const sample = head.subarray(0, 512);
  if (sample.length && !sample.includes(0)) return EXT.txt;
  return { mime: "application/octet-stream", kind: "unsupported", label: ext ? ext.toUpperCase() : "Unknown" };
}

export function describeType(fileName: string, mime: string) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return EXT[ext]?.label ?? mime;
}

export async function pdfPages(file: string): Promise<number | null> {
  try {
    const { stdout } = await run("pdfinfo", [file], { timeout: 20_000 });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Converts a file to something CUPS can print natively. Returns the new path and mime type. */
export async function toPrintable(file: string, kind: FileKind, mime: string): Promise<{ path: string; mime: string; via?: string }> {
  const outDir = path.join(path.dirname(file), `conv-${path.basename(file)}`);
  await fs.mkdir(outDir, { recursive: true });
  switch (kind) {
    case "native":
      return { path: file, mime };
    case "office": {
      // A private profile dir avoids lock contention between concurrent conversions.
      const profile = `file://${outDir}/lo-profile`;
      await run("soffice", [
        `-env:UserInstallation=${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, file,
      ], { timeout: 180_000 });
      const out = (await fs.readdir(outDir)).find((f) => f.endsWith(".pdf"));
      if (!out) throw new Error("LibreOffice produced no PDF");
      return { path: path.join(outDir, out), mime: "application/pdf", via: "LibreOffice" };
    }
    case "image-convert": {
      const out = path.join(outDir, "image.png");
      await run("convert", [`${file}[0]`, "-auto-orient", out], { timeout: 120_000 });
      return { path: out, mime: "image/png", via: "ImageMagick" };
    }
    case "svg": {
      const out = path.join(outDir, "image.pdf");
      await run("rsvg-convert", ["-f", "pdf", "-o", out, file], { timeout: 60_000 });
      return { path: out, mime: "application/pdf", via: "librsvg" };
    }
    default:
      throw new Error("This file type cannot be printed");
  }
}
