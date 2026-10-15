import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const g = globalThis as unknown as { __db?: Database.Database };

function open() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "print.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,           -- also the CUPS queue name
      name TEXT NOT NULL,
      uri TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      capabilities TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      kind TEXT NOT NULL,            -- native | office | image-convert | svg | unsupported
      pages INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      upload_id TEXT NOT NULL,
      printer_id TEXT NOT NULL,
      printer_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      pages INTEGER,
      options TEXT NOT NULL,
      stage TEXT NOT NULL,           -- queued-local | converting | submitting | pending | held | processing | stopped | completed | canceled | aborted | failed
      cups_job_id INTEGER,
      cups_state TEXT,
      state_reasons TEXT NOT NULL DEFAULT '[]',
      state_message TEXT,
      impressions_completed INTEGER,
      sheets_completed INTEGER,
      k_octets INTEGER,
      error TEXT,
      attrs TEXT NOT NULL DEFAULT '{}',
      device TEXT,                   -- matching job as reported by the printer itself
      created_at INTEGER NOT NULL,
      submitted_at INTEGER,
      processing_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_stage ON jobs(stage);
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,           -- info | warn | error | success
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, ts);
  `);
  return db;
}

// Opened lazily so importing this module (e.g. during `next build`) doesn't touch the file.
export const db = new Proxy({} as Database.Database, {
  get(_t, prop) {
    const d = (g.__db ??= open());
    const v = Reflect.get(d, prop, d);
    return typeof v === "function" ? v.bind(d) : v;
  },
});

// ---------- types ----------

export interface PrinterCapabilities {
  makeAndModel?: string;
  colorSupported?: boolean;
  colorModes?: string[];
  sidesSupported?: string[];
  documentFormats?: string[];
  ppm?: number;
  ppmColor?: number;
  firmware?: string;
  uuid?: string;
  moreInfo?: string;
  probedAt?: number;
}

export interface PrinterRow {
  id: string;
  name: string;
  uri: string;
  location: string;
  description: string;
  enabled: boolean;
  isDefault: boolean;
  capabilities: PrinterCapabilities;
  createdAt: number;
  updatedAt: number;
}

export interface JobOptions {
  color: "color" | "monochrome";
  sides: "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
  copies: number;
}

export interface JobRow {
  id: string;
  batchId: string;
  clientId: string;
  uploadId: string;
  printerId: string;
  printerName: string;
  fileName: string;
  fileSize: number;
  mime: string;
  pages: number | null;
  options: JobOptions;
  stage: string;
  cupsJobId: number | null;
  cupsState: string | null;
  stateReasons: string[];
  stateMessage: string | null;
  impressionsCompleted: number | null;
  sheetsCompleted: number | null;
  kOctets: number | null;
  error: string | null;
  attrs: Record<string, unknown>;
  device: Record<string, unknown> | null;
  createdAt: number;
  submittedAt: number | null;
  processingAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface JobEvent { id: number; jobId: string; ts: number; level: string; message: string }

export interface UploadRow {
  id: string;
  clientId: string;
  name: string;
  path: string;
  size: number;
  mime: string;
  kind: string;
  pages: number | null;
  createdAt: number;
}

// ---------- mappers ----------

type Raw = Record<string, unknown>;

export const mapPrinter = (r: Raw): PrinterRow => ({
  id: r.id as string,
  name: r.name as string,
  uri: r.uri as string,
  location: r.location as string,
  description: r.description as string,
  enabled: !!r.enabled,
  isDefault: !!r.is_default,
  capabilities: JSON.parse(r.capabilities as string),
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

export const mapJob = (r: Raw): JobRow => ({
  id: r.id as string,
  batchId: r.batch_id as string,
  clientId: r.client_id as string,
  uploadId: r.upload_id as string,
  printerId: r.printer_id as string,
  printerName: r.printer_name as string,
  fileName: r.file_name as string,
  fileSize: r.file_size as number,
  mime: r.mime as string,
  pages: r.pages as number | null,
  options: JSON.parse(r.options as string),
  stage: r.stage as string,
  cupsJobId: r.cups_job_id as number | null,
  cupsState: r.cups_state as string | null,
  stateReasons: JSON.parse(r.state_reasons as string),
  stateMessage: r.state_message as string | null,
  impressionsCompleted: r.impressions_completed as number | null,
  sheetsCompleted: r.sheets_completed as number | null,
  kOctets: r.k_octets as number | null,
  error: r.error as string | null,
  attrs: JSON.parse(r.attrs as string),
  device: r.device ? JSON.parse(r.device as string) : null,
  createdAt: r.created_at as number,
  submittedAt: r.submitted_at as number | null,
  processingAt: r.processing_at as number | null,
  completedAt: r.completed_at as number | null,
  updatedAt: r.updated_at as number,
});

export const mapUpload = (r: Raw): UploadRow => ({
  id: r.id as string,
  clientId: r.client_id as string,
  name: r.name as string,
  path: r.path as string,
  size: r.size as number,
  mime: r.mime as string,
  kind: r.kind as string,
  pages: r.pages as number | null,
  createdAt: r.created_at as number,
});

// ---------- queries ----------

export const ACTIVE_STAGES = ["queued-local", "converting", "submitting", "pending", "held", "processing", "stopped"];
export const isActiveStage = (s: string) => ACTIVE_STAGES.includes(s);

export function listPrinters(includeDisabled = true): PrinterRow[] {
  const rows = db
    .prepare(`SELECT * FROM printers ${includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY is_default DESC, name`)
    .all() as Raw[];
  return rows.map(mapPrinter);
}

export function getPrinter(id: string): PrinterRow | undefined {
  const r = db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as Raw | undefined;
  return r && mapPrinter(r);
}

export function getJob(id: string): JobRow | undefined {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Raw | undefined;
  return r && mapJob(r);
}

export function getUpload(id: string): UploadRow | undefined {
  const r = db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Raw | undefined;
  return r && mapUpload(r);
}

export function listActiveJobs(): JobRow[] {
  const q = `SELECT * FROM jobs WHERE stage IN (${ACTIVE_STAGES.map(() => "?").join(",")})`;
  return (db.prepare(q).all(...ACTIVE_STAGES) as Raw[]).map(mapJob);
}

export function listRecentJobs(opts: { clientId?: string; sinceMs?: number; limit?: number }): JobRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.clientId) { where.push("client_id = ?"); args.push(opts.clientId); }
  if (opts.sinceMs) { where.push("created_at >= ?"); args.push(opts.sinceMs); }
  const q = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
  args.push(opts.limit ?? 100);
  return (db.prepare(q).all(...args) as Raw[]).map(mapJob);
}

export function eventsFor(jobIds: string[]): Record<string, JobEvent[]> {
  const out: Record<string, JobEvent[]> = {};
  if (!jobIds.length) return out;
  const rows = db
    .prepare(`SELECT * FROM job_events WHERE job_id IN (${jobIds.map(() => "?").join(",")}) ORDER BY ts, id`)
    .all(...jobIds) as Raw[];
  for (const r of rows) {
    const e = { id: r.id as number, jobId: r.job_id as string, ts: r.ts as number, level: r.level as string, message: r.message as string };
    (out[e.jobId] ??= []).push(e);
  }
  return out;
}

export function addEvent(jobId: string, level: "info" | "warn" | "error" | "success", message: string) {
  db.prepare("INSERT INTO job_events (job_id, ts, level, message) VALUES (?, ?, ?, ?)").run(jobId, Date.now(), level, message);
}

const JOB_COLUMNS: Record<string, string> = {
  stage: "stage", cupsJobId: "cups_job_id", cupsState: "cups_state", stateMessage: "state_message",
  impressionsCompleted: "impressions_completed", sheetsCompleted: "sheets_completed", kOctets: "k_octets",
  error: "error", pages: "pages", submittedAt: "submitted_at", processingAt: "processing_at", completedAt: "completed_at",
};

export function updateJob(id: string, patch: Partial<JobRow>) {
  const sets: string[] = ["updated_at = ?"];
  const args: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(patch)) {
    if (k in JOB_COLUMNS) { sets.push(`${JOB_COLUMNS[k]} = ?`); args.push(v); }
    else if (k === "stateReasons") { sets.push("state_reasons = ?"); args.push(JSON.stringify(v)); }
    else if (k === "attrs") { sets.push("attrs = ?"); args.push(JSON.stringify(v)); }
    else if (k === "device") { sets.push("device = ?"); args.push(v ? JSON.stringify(v) : null); }
  }
  args.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}
