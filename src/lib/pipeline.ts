import { randomUUID } from "node:crypto";
import { addEvent, db, getJob, getPrinter, getUpload, JobOptions, JobRow, listActiveJobs, listPrinters, updateJob } from "./db";
import { cancelJob as cupsCancel, getJobInfo, getQueueInfo, QueueInfo, queueExists, submitJob, upsertQueue } from "./cups";
import { pdfPages, toPrintable, FileKind } from "./convert";
import { describeReason, DeviceStatus, deviceStatus } from "./device";
import fs from "node:fs/promises";
import path from "node:path";

// ---------- shared in-memory status cache ----------

interface State {
  device: Record<string, DeviceStatus>;
  queue: Record<string, QueueInfo & { checkedAt: number; error?: string }>;
  started: boolean;
  working: Set<string>;
}
const g = globalThis as unknown as { __printState?: State };
export const state: State = (g.__printState ??= { device: {}, queue: {}, started: false, working: new Set() });

// ---------- creating jobs ----------

export function createJobs(input: { clientId: string; uploadIds: string[]; printerId: string; options: JobOptions }): JobRow[] {
  const printer = getPrinter(input.printerId);
  if (!printer) throw new Error("Unknown printer");
  if (!printer.enabled) throw new Error("This printer is disabled");
  const caps = printer.capabilities;
  const options: JobOptions = {
    color: caps.colorSupported === false ? "monochrome" : input.options.color,
    sides: caps.sidesSupported?.length && !caps.sidesSupported.includes(input.options.sides) ? "one-sided" : input.options.sides,
    copies: Math.max(1, Math.min(99, Math.floor(input.options.copies || 1))),
  };
  const batchId = randomUUID();
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO jobs (id, batch_id, client_id, upload_id, printer_id, printer_name, file_name, file_size, mime, pages, options, stage, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued-local', ?, ?)`);
  const ids: string[] = [];
  db.transaction(() => {
    for (const uid of input.uploadIds) {
      const u = getUpload(uid);
      if (!u) throw new Error(`Upload ${uid} not found (it may have expired)`);
      if (u.kind === "unsupported") throw new Error(`${u.name} is not a printable file type`);
      const id = randomUUID();
      insert.run(id, batchId, input.clientId, u.id, printer.id, printer.name, u.name, u.size, u.mime, u.pages, JSON.stringify(options), now, now);
      ids.push(id);
    }
  })();
  for (const id of ids) {
    const optText = `${options.color === "color" ? "Color" : "Black & white"}, ${sidesLabel(options.sides)}${options.copies > 1 ? `, ${options.copies} copies` : ""}`;
    addEvent(id, "info", `Job created for ${printer.name} (${optText})`);
  }
  // Process sequentially so files print in the order they were added.
  void (async () => { for (const id of ids) await processJob(id); })();
  return ids.map((id) => getJob(id)!);
}

export const sidesLabel = (s: string) =>
  s === "one-sided" ? "one-sided" : s === "two-sided-long-edge" ? "double-sided (long edge)" : "double-sided (short edge)";

async function processJob(id: string) {
  if (state.working.has(id)) return;
  state.working.add(id);
  try {
    const job = getJob(id);
    if (!job || job.stage !== "queued-local") return;
    const upload = getUpload(job.uploadId);
    if (!upload) throw new Error("Uploaded file is no longer available");
    let file = upload.path;
    let mime = upload.mime;
    if (upload.kind !== "native") {
      updateJob(id, { stage: "converting" });
      addEvent(id, "info", "Converting document to a printable format…");
      const t0 = Date.now();
      const out = await toPrintable(upload.path, upload.kind as FileKind, upload.mime);
      file = out.path; mime = out.mime;
      const pages = mime === "application/pdf" ? await pdfPages(file) : 1;
      if (pages) updateJob(id, { pages });
      addEvent(id, "info", `Converted with ${out.via} in ${((Date.now() - t0) / 1000).toFixed(1)}s${pages ? ` — ${pages} page${pages === 1 ? "" : "s"}` : ""}`);
    }
    if (getJob(id)?.stage === "canceled") return;
    updateJob(id, { stage: "submitting" });
    addEvent(id, "info", "Sending to print server (CUPS)…");
    const cupsJobId = await submitJob(job.printerId, file, {
      jobName: job.fileName,
      user: "print-thing",
      format: mime,
      color: job.options.color,
      sides: job.options.sides,
      copies: job.options.copies,
    });
    updateJob(id, { stage: "pending", cupsJobId, submittedAt: Date.now() });
    addEvent(id, "info", `Accepted by print server as job #${cupsJobId}`);
    await pollJob(getJob(id)!);
  } catch (e) {
    const msg = (e as Error).message;
    updateJob(id, { stage: "failed", error: msg, completedAt: Date.now() });
    addEvent(id, "error", `Failed: ${msg}`);
  } finally {
    state.working.delete(id);
  }
}

export async function cancel(id: string) {
  const job = getJob(id);
  if (!job) throw new Error("Job not found");
  if (job.cupsJobId && ["pending", "held", "processing", "stopped"].includes(job.stage)) {
    await cupsCancel(job.cupsJobId);
    addEvent(id, "warn", "Cancel requested");
    await pollJob(getJob(id)!);
  } else if (["queued-local", "converting", "submitting"].includes(job.stage)) {
    updateJob(id, { stage: "canceled", completedAt: Date.now() });
    addEvent(id, "warn", "Canceled before it was sent to the printer");
  }
}

/** Retries a failed/aborted job using the same file, printer and options. */
export function retry(id: string, clientId: string) {
  const job = getJob(id);
  if (!job) throw new Error("Job not found");
  return createJobs({ clientId, uploadIds: [job.uploadId], printerId: job.printerId, options: job.options });
}

// ---------- polling ----------

const STAGE_FROM_CUPS: Record<string, string> = {
  pending: "pending", "pending-held": "held", processing: "processing", "processing-stopped": "stopped",
  canceled: "canceled", aborted: "aborted", completed: "completed",
};

const STAGE_TEXT: Record<string, string> = {
  pending: "Waiting in the print queue",
  held: "Job is on hold",
  processing: "Printing",
  stopped: "Printing paused — the printer needs attention",
  canceled: "Job canceled",
  aborted: "Job aborted by the print system",
  completed: "Job completed",
};

export const isTroubleMessage = (m: string) =>
  /unavailable|not exist|unable|offline|error|jam|out of|empty|open|low|failed|cannot|not responding/i.test(m);

async function pollJob(job: JobRow) {
  if (!job.cupsJobId) return;
  let info;
  try {
    info = await getJobInfo(job.cupsJobId);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not-found|gone/.test(msg)) {
      updateJob(job.id, { stage: "failed", error: "The print server lost track of this job", completedAt: Date.now() });
      addEvent(job.id, "error", "Print server no longer knows about this job");
    }
    return;
  }
  const stage = STAGE_FROM_CUPS[info.state] ?? job.stage;
  const reasons = info.reasons.filter((r) => r !== "none");
  const terminal = ["completed", "canceled", "aborted"].includes(stage);
  // A completed job's last printer message is often stale (e.g. an earlier "unavailable" retry).
  const message = stage === "completed" ? null : info.printerStateMessage || info.message || null;
  const patch: Partial<JobRow> = {
    stage, cupsState: info.state, stateReasons: reasons, stateMessage: message,
    impressionsCompleted: info.impressionsCompleted ?? null,
    sheetsCompleted: info.sheetsCompleted ?? null,
    kOctets: info.kOctets ?? null,
    attrs: info.raw as Record<string, unknown>,
  };
  if (stage === "processing" && !job.processingAt) patch.processingAt = (info.timeProcessing ? info.timeProcessing * 1000 : Date.now());
  if (["completed", "canceled", "aborted"].includes(stage) && !job.completedAt) patch.completedAt = info.timeCompleted ? info.timeCompleted * 1000 : Date.now();

  // Pull the matching job from the printer itself for device-level progress.
  const dev = state.device[job.printerId];
  if (dev?.activeJobs?.length && stage === "processing") {
    const match = dev.activeJobs.find((d) => d.name === job.fileName) ?? (dev.activeJobs.length === 1 ? dev.activeJobs[0] : undefined);
    if (match) patch.device = match as unknown as Record<string, unknown>;
  }

  // Record a timeline of meaningful changes.
  if (stage !== job.stage) {
    const level = stage === "completed" ? "success" : stage === "aborted" || stage === "stopped" ? "error" : stage === "canceled" ? "warn" : "info";
    let text = STAGE_TEXT[stage] ?? stage;
    if (stage === "completed" && reasons.includes("job-completed-with-warnings")) text = "Job completed with warnings";
    if (stage === "completed" && reasons.includes("job-completed-with-errors")) text = "Job completed with errors";
    addEvent(job.id, level, text);
  }
  const newReasons = reasons.filter((r) => !job.stateReasons.includes(r) && !r.startsWith("job-completed") && r !== "job-printing"
    && !(terminal && ["processing-to-stop-point", "job-queued"].includes(r)));
  for (const r of newReasons) {
    const d = describeReason(r);
    addEvent(job.id, d.severity === "error" ? "error" : d.severity === "warning" ? "warn" : "info", `${d.text} (${r})`);
  }
  if (message && message !== job.stateMessage) {
    addEvent(job.id, isTroubleMessage(message) ? "warn" : "info", `Printer says: “${message}”`);
  }
  // CUPS counts pages as its filters hand them to the printer — "processed", not necessarily on paper yet.
  const imp = info.impressionsCompleted;
  if (imp !== undefined && imp !== job.impressionsCompleted && imp > 0) {
    addEvent(job.id, "info", `${imp} page${imp === 1 ? "" : "s"} processed${job.pages ? ` of ${job.pages * job.options.copies}` : ""}`);
  }
  updateJob(job.id, patch);
}

// CUPS config lives inside the container; recreate queues from the database when missing
// (e.g. after the container is rebuilt). Retried every printer poll until it succeeds.
const lastQueueAttempt: Record<string, number> = {};
async function ensureQueue(p: ReturnType<typeof listPrinters>[number]) {
  if (await queueExists(p.id)) return;
  if (Date.now() - (lastQueueAttempt[p.id] ?? 0) < 60_000) return;
  lastQueueAttempt[p.id] = Date.now();
  try {
    await upsertQueue({ id: p.id, uri: p.uri, name: p.name, location: p.location, enabled: p.enabled });
    console.log(`[print-thing] recreated CUPS queue ${p.id}`);
  } catch (e) {
    console.warn(`[print-thing] could not create queue ${p.id}: ${(e as Error).message}`);
  }
}

async function pollPrinters() {
  await Promise.all(listPrinters(false).map(async (p) => {
    await ensureQueue(p);
    const [dev, queue] = await Promise.all([
      deviceStatus(p.uri),
      getQueueInfo(p.id).then((q) => ({ ...q, checkedAt: Date.now() })).catch((e) => ({
        state: "unknown", reasons: [], accepting: false, checkedAt: Date.now(), error: (e as Error).message,
      })),
    ]);
    state.device[p.id] = dev;
    state.queue[p.id] = queue;
  }));
}

async function cleanup() {
  const hours = Number(process.env.RETENTION_HOURS ?? 72);
  const cutoff = Date.now() - hours * 3600_000;
  const old = db.prepare("SELECT id, path FROM uploads WHERE created_at < ?").all(cutoff) as { id: string; path: string }[];
  for (const u of old) {
    const active = db.prepare("SELECT 1 FROM jobs WHERE upload_id = ? AND stage IN ('queued-local','converting','submitting','pending','held','processing','stopped')").get(u.id);
    if (active) continue;
    await fs.rm(path.dirname(u.path), { recursive: true, force: true }).catch(() => {});
    db.prepare("DELETE FROM uploads WHERE id = ?").run(u.id);
  }
  db.prepare("DELETE FROM jobs WHERE created_at < ? AND stage NOT IN ('queued-local','converting','submitting','pending','held','processing','stopped')").run(cutoff);
}

export function startPoller() {
  if (state.started) return;
  state.started = true;
  console.log("[print-thing] status poller started");

  // Jobs that were mid-pipeline when the server restarted.
  for (const j of listActiveJobs()) {
    if (["queued-local", "converting", "submitting"].includes(j.stage)) {
      updateJob(j.id, { stage: "queued-local" });
      void processJob(j.id);
    }
  }

  let busyJobs = false, busyPrinters = false;
  setInterval(async () => {
    if (busyJobs) return;
    busyJobs = true;
    try {
      for (const j of listActiveJobs()) if (j.cupsJobId && !state.working.has(j.id)) await pollJob(j);
    } catch (e) { console.error("[poller] jobs", e); } finally { busyJobs = false; }
  }, 1500);

  const printerLoop = async () => {
    if (!busyPrinters) {
      busyPrinters = true;
      try { await pollPrinters(); } catch (e) { console.error("[poller] printers", e); } finally { busyPrinters = false; }
    }
    // Poll faster while anything is printing.
    setTimeout(printerLoop, listActiveJobs().length ? 3000 : 10000);
  };
  void printerLoop();
  setInterval(() => void cleanup().catch((e) => console.error("[cleanup]", e)), 3600_000);
}

export async function refreshPrinter(id: string) {
  const p = getPrinter(id);
  if (!p) return;
  state.device[id] = await deviceStatus(p.uri);
  state.queue[id] = await getQueueInfo(id).then((q) => ({ ...q, checkedAt: Date.now() })).catch((e) => ({
    state: "unknown", reasons: [], accepting: false, checkedAt: Date.now(), error: (e as Error).message,
  }));
}
