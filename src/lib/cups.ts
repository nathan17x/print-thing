import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { asArray, asNumber, asString, ippRequest, IppGroup, JobState, Op, PrinterState, Tag, AttrSpec } from "./ipp";

const run = promisify(execFile);

/** The CUPS scheduler running inside the same container. */
export const CUPS_HOST = process.env.CUPS_HOST ?? "localhost:631";
const queueUri = (queue: string) => `ipp://${CUPS_HOST}/printers/${queue}`;
const jobUri = (id: number) => `ipp://${CUPS_HOST}/jobs/${id}`;

async function cli(cmd: string, args: string[]) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 90_000 });
    return (stdout + stderr).trim();
  } catch (e) {
    const err = e as Error & { stderr?: string; stdout?: string; code?: string };
    if (err.code === "ENOENT") throw new Error(`${cmd} not found — CUPS is not installed (are you running outside the Docker container?)`);
    throw new Error((err.stderr || err.stdout || err.message).trim());
  }
}

/**
 * Creates or updates a driverless IPP Everywhere queue for a printer.
 * CUPS queries the printer itself to generate the PPD, so the printer must be reachable.
 */
export async function upsertQueue(p: { id: string; uri: string; name: string; location: string; enabled: boolean }) {
  await cli("lpadmin", [
    "-p", p.id,
    "-v", p.uri,
    "-m", "everywhere",
    "-D", p.name,
    "-L", p.location || "",
    "-o", "printer-error-policy=retry-job",
    "-o", "printer-is-shared=false",
    ...(p.enabled ? ["-E"] : []),
  ]);
  if (p.enabled) {
    await cli("cupsenable", [p.id]);
    await cli("cupsaccept", [p.id]);
  } else {
    await cli("cupsdisable", ["-r", "Disabled by administrator", p.id]).catch(() => {});
    await cli("cupsreject", ["-r", "Disabled by administrator", p.id]).catch(() => {});
  }
}

export async function updateQueueMeta(p: { id: string; name: string; location: string }) {
  await cli("lpadmin", ["-p", p.id, "-D", p.name, "-L", p.location || ""]);
}

export async function deleteQueue(id: string) {
  await cli("lpadmin", ["-x", id]).catch((e) => {
    if (!/does not exist|not found/i.test(String(e))) throw e;
  });
}

export async function resumeQueue(id: string) {
  await cli("cupsenable", [id]);
  await cli("cupsaccept", [id]);
}

export async function cancelJob(cupsJobId: number) {
  await cli("cancel", [String(cupsJobId)]);
}

export async function queueExists(id: string) {
  try {
    await ippRequest(queueUri(id), Op.GetPrinterAttributes, {
      operation: [[Tag.uri, "printer-uri", queueUri(id)], [Tag.keyword, "requested-attributes", ["printer-state"]]],
    }, { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

export interface SubmitOptions {
  jobName: string;
  user: string;
  format: string;
  color: "color" | "monochrome";
  sides: string;
  copies: number;
}

export async function submitJob(queue: string, filePath: string, o: SubmitOptions): Promise<number> {
  const data = await fs.readFile(filePath);
  const job: AttrSpec[] = [
    [Tag.keyword, "print-color-mode", o.color],
    [Tag.keyword, "sides", o.sides],
    [Tag.integer, "copies", Math.max(1, Math.min(99, o.copies))],
  ];
  const res = await ippRequest(queueUri(queue), Op.PrintJob, {
    operation: [
      [Tag.uri, "printer-uri", queueUri(queue)],
      [Tag.nameWithoutLanguage, "requesting-user-name", o.user],
      [Tag.nameWithoutLanguage, "job-name", o.jobName],
      [Tag.mimeMediaType, "document-format", o.format],
    ],
    job,
  }, { data, timeoutMs: 120_000 });
  const id = asNumber(res.job[0]?.["job-id"]);
  if (!id) throw new Error(`CUPS did not return a job id (${res.status})`);
  return id;
}

export interface CupsJobInfo {
  state: string;
  reasons: string[];
  message?: string;
  printerStateMessage?: string;
  impressionsCompleted?: number;
  sheetsCompleted?: number;
  pagesCompleted?: number;
  kOctets?: number;
  timeCreated?: number;
  timeProcessing?: number;
  timeCompleted?: number;
  raw: IppGroup;
}

export async function getJobInfo(cupsJobId: number): Promise<CupsJobInfo> {
  const res = await ippRequest(jobUri(cupsJobId), Op.GetJobAttributes, {
    operation: [
      [Tag.uri, "job-uri", jobUri(cupsJobId)],
      [Tag.keyword, "requested-attributes", ["all"]],
    ],
  }, { timeoutMs: 4000 });
  const j = res.job[0] ?? {};
  return {
    state: JobState[asNumber(j["job-state"]) ?? 0] ?? "unknown",
    reasons: asArray(j["job-state-reasons"]).map(String),
    message: asString(j["job-state-message"]) || undefined,
    printerStateMessage: asString(j["job-printer-state-message"]) || undefined,
    impressionsCompleted: asNumber(j["job-impressions-completed"]),
    sheetsCompleted: asNumber(j["job-media-sheets-completed"]),
    pagesCompleted: asNumber(j["job-pages-completed"]),
    kOctets: asNumber(j["job-k-octets"]),
    timeCreated: asNumber(j["time-at-creation"]),
    timeProcessing: asNumber(j["time-at-processing"]),
    timeCompleted: asNumber(j["time-at-completed"]),
    raw: j,
  };
}

export interface QueueInfo {
  state: string;
  reasons: string[];
  message?: string;
  accepting: boolean;
  queuedJobs?: number;
}

export async function getQueueInfo(id: string): Promise<QueueInfo> {
  const res = await ippRequest(queueUri(id), Op.GetPrinterAttributes, {
    operation: [
      [Tag.uri, "printer-uri", queueUri(id)],
      [Tag.keyword, "requested-attributes", ["printer-state", "printer-state-reasons", "printer-state-message", "printer-is-accepting-jobs", "queued-job-count"]],
    ],
  }, { timeoutMs: 3000 });
  const p = res.printer[0] ?? {};
  return {
    state: PrinterState[asNumber(p["printer-state"]) ?? 0] ?? "unknown",
    reasons: asArray(p["printer-state-reasons"]).map(String).filter((r) => r !== "none"),
    message: asString(p["printer-state-message"]) || undefined,
    accepting: p["printer-is-accepting-jobs"] === true,
    queuedJobs: asNumber(p["queued-job-count"]),
  };
}
