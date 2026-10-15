// Talks directly to the physical printer over IPP for rich, device-level status.
import { asArray, asNumber, asString, IppGroup, ippRequest, IppValue, JobState, Op, PrinterState, Tag } from "./ipp";
import type { PrinterCapabilities } from "./db";

const STATUS_ATTRS = [
  "printer-state", "printer-state-reasons", "printer-state-message", "printer-state-change-time",
  "printer-is-accepting-jobs", "queued-job-count", "printer-up-time", "printer-current-time",
  "printer-alert", "printer-alert-description",
  "marker-names", "marker-levels", "marker-colors", "marker-types", "marker-low-levels", "marker-high-levels",
  "printer-supply-description", "printer-supply",
  "media-ready", "media-col-ready", "printer-input-tray", "printer-output-tray",
  "printer-make-and-model", "printer-info", "printer-location", "printer-name",
  "printer-firmware-string-version", "printer-firmware-name", "printer-uuid", "printer-more-info",
  "color-supported", "print-color-mode-supported", "sides-supported", "pages-per-minute", "pages-per-minute-color",
  "printer-impressions-completed", "printer-media-sheets-completed",
];

export interface Supply {
  name: string;
  level: number | null; // percent, null = unknown
  color: string;        // css color(s), e.g. "#00FFFF" or "#000000"
  type: string;
  low: number | null;
}

export interface Tray { name: string; media?: string; level?: string; state?: string; raw: string }

export interface DeviceStatus {
  reachable: boolean;
  error?: string;
  checkedAt: number;
  state?: string;
  reasons: { keyword: string; severity: "error" | "warning" | "report" | "info"; text: string }[];
  message?: string;
  accepting?: boolean;
  queuedJobs?: number;
  upTimeSec?: number;
  makeAndModel?: string;
  info?: string;
  location?: string;
  firmware?: string;
  moreInfo?: string;
  supplies: Supply[];
  mediaReady: string[];
  trays: Tray[];
  alerts: string[];
  totalImpressions?: number;
  totalSheets?: number;
  activeJobs: DeviceJob[];
}

export interface DeviceJob {
  id: number;
  name?: string;
  user?: string;
  state: string;
  reasons: string[];
  message?: string;
  impressionsCompleted?: number;
  sheetsCompleted?: number;
  createdAt?: number;
}

const COMMON_PATHS = ["/ipp/print", "/ipp/printer", "/ipp", "/printers/default", ""];

/** Accepts an IP, hostname, or URI; returns candidate printer URIs to try, best first. */
export function candidateUris(input: string): string[] {
  const s = input.trim();
  if (/^(ipps?|https?):\/\//i.test(s)) {
    const u = new URL(s.replace(/^ipps:/i, "https:").replace(/^ipp:/i, "http:"));
    if (u.pathname && u.pathname !== "/") return [s];
    const scheme = /^(ipps|https)/i.test(s) ? "ipps" : "ipp";
    return COMMON_PATHS.map((p) => `${scheme}://${u.host}${p}`);
  }
  const host = s.replace(/\/+$/, "");
  return [...COMMON_PATHS.map((p) => `ipp://${host}${p}`), `ipps://${host}/ipp/print`];
}

async function getAttrs(uri: string, attrs: string[], timeoutMs = 5000): Promise<IppGroup> {
  const res = await ippRequest(uri, Op.GetPrinterAttributes, {
    operation: [
      [Tag.uri, "printer-uri", uri],
      [Tag.keyword, "requested-attributes", attrs],
    ],
  }, { timeoutMs });
  return res.printer[0] ?? {};
}

export interface ProbeResult {
  uri: string;
  capabilities: PrinterCapabilities;
  suggestedName?: string;
  location?: string;
  attempts: { uri: string; error?: string }[];
}

export async function probe(input: string): Promise<ProbeResult> {
  const attempts: { uri: string; error?: string }[] = [];
  for (const uri of candidateUris(input)) {
    try {
      const p = await getAttrs(uri, ["all", "media-col-database"], 6000);
      attempts.push({ uri });
      return {
        uri,
        capabilities: capabilitiesFrom(p),
        suggestedName: asString(p["printer-info"]) || asString(p["printer-name"]) || asString(p["printer-make-and-model"]),
        location: asString(p["printer-location"]),
        attempts,
      };
    } catch (e) {
      attempts.push({ uri, error: (e as Error).message });
      // Host unreachable is fatal for all paths on that host; stop early.
      if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|Timed out/.test((e as Error).message) && attempts.length > 1) break;
    }
  }
  const err = new Error(`No IPP printer answered. Tried:\n${attempts.map((a) => `• ${a.uri} — ${a.error}`).join("\n")}`);
  throw Object.assign(err, { attempts });
}

export function capabilitiesFrom(p: IppGroup): PrinterCapabilities {
  const colorModes = asArray(p["print-color-mode-supported"]).map(String);
  return {
    makeAndModel: asString(p["printer-make-and-model"]),
    colorSupported: p["color-supported"] === true || colorModes.includes("color"),
    colorModes,
    sidesSupported: asArray(p["sides-supported"]).map(String),
    documentFormats: asArray(p["document-format-supported"]).map(String),
    ppm: asNumber(p["pages-per-minute"]),
    ppmColor: asNumber(p["pages-per-minute-color"]),
    firmware: asArray(p["printer-firmware-string-version"]).map(String).join(", ") || undefined,
    uuid: asString(p["printer-uuid"]),
    moreInfo: asString(p["printer-more-info"]),
    probedAt: Date.now(),
  };
}

// ---------- status ----------

const MARKER_COLOR_NAMES: Record<string, string> = {
  cyan: "#00B7EB", magenta: "#E5007E", yellow: "#FFE600", black: "#1a1a1a", "photo-black": "#1a1a1a",
  "matte-black": "#222", gray: "#888", "light-cyan": "#7fdbff", "light-magenta": "#ff8cc6",
};

function parseKv(s: string): Record<string, string> {
  // e.g. "type=sheetFeedAutoRemovableTray;mediafeed=0;...;name=Tray 1;"
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function mediaFromCol(v: IppValue): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const c = v as Record<string, IppValue>;
  const parts: string[] = [];
  if (c["media-source"]) parts.push(String(c["media-source"]));
  const size = c["media-size"] as Record<string, IppValue> | undefined;
  if (size && typeof size === "object") {
    const x = Number(size["x-dimension"]), y = Number(size["y-dimension"]);
    if (x && y) parts.push(describeSize(x, y));
  }
  if (c["media-type"]) parts.push(String(c["media-type"]));
  return parts.join(" · ") || undefined;
}

function describeSize(x: number, y: number) {
  // units are hundredths of mm
  const known: [number, number, string][] = [[21590, 27940, "Letter"], [21590, 35560, "Legal"], [21000, 29700, "A4"], [14800, 21000, "A5"], [10160, 15240, "4×6 in"], [12700, 17780, "5×7 in"]];
  const hit = known.find(([w, h]) => Math.abs(w - x) < 100 && Math.abs(h - y) < 100);
  return hit ? hit[2] : `${(x / 100).toFixed(0)}×${(y / 100).toFixed(0)} mm`;
}

export { describeReason, REASON_TEXT } from "./reasons";
import { describeReason } from "./reasons";

const LEVEL_TEXT: Record<string, string> = { "-1": "unknown", "-2": "unknown", "-3": "has paper" };

export async function deviceStatus(uri: string): Promise<DeviceStatus> {
  const base: DeviceStatus = { reachable: false, checkedAt: Date.now(), reasons: [], supplies: [], mediaReady: [], trays: [], alerts: [], activeJobs: [] };
  let p: IppGroup;
  try {
    p = await getAttrs(uri, STATUS_ATTRS, 4000);
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }

  const names = asArray(p["marker-names"]).map(String);
  const levels = asArray(p["marker-levels"]).map(Number);
  const colors = asArray(p["marker-colors"]).map(String);
  const types = asArray(p["marker-types"]).map(String);
  const lows = asArray(p["marker-low-levels"]).map(Number);
  let supplies: Supply[] = names.map((name, i) => ({
    name,
    level: levels[i] !== undefined && levels[i] >= 0 ? levels[i] : null,
    color: colors[i]?.split("#").filter(Boolean).map((c) => `#${c}`)[0] ?? "#888",
    type: types[i] ?? "",
    low: lows[i] ?? null,
  }));

  // Fall back to PWG printer-supply if the marker-* attributes are missing.
  if (!supplies.length) {
    const desc = asArray(p["printer-supply-description"]).map(String);
    supplies = asArray(p["printer-supply"]).map((raw, i) => {
      const kv = parseKv(String(raw));
      const max = Number(kv.maxcapacity ?? 100);
      const lvl = Number(kv.level);
      const colorName = (kv.colorantname ?? "").toLowerCase();
      return {
        name: desc[i] ?? kv.colorantname ?? `Supply ${i + 1}`,
        level: Number.isFinite(lvl) && lvl >= 0 && max > 0 ? Math.round((lvl / max) * 100) : null,
        color: MARKER_COLOR_NAMES[colorName] ?? "#888",
        type: kv.type ?? "",
        low: null,
      };
    });
  }

  const trays: Tray[] = asArray(p["printer-input-tray"]).map((raw) => {
    const kv = parseKv(String(raw));
    const lvl = kv.level;
    const max = Number(kv.maxcapacity);
    let level: string | undefined;
    if (lvl !== undefined) {
      const n = Number(lvl);
      level = LEVEL_TEXT[lvl] ?? (n === 0 ? "empty" : max > 0 ? `${Math.round((n / max) * 100)}%` : `${n}`);
    }
    return { name: kv.name ?? kv.type ?? "Tray", level, state: kv.status, raw: String(raw) };
  });

  const mediaReady = asArray(p["media-col-ready"]).map(mediaFromCol).filter((m): m is string => !!m);
  if (!mediaReady.length) mediaReady.push(...asArray(p["media-ready"]).map(String));

  const alerts = asArray(p["printer-alert-description"]).map(String).filter(Boolean);
  const upTime = asNumber(p["printer-up-time"]);

  const status: DeviceStatus = {
    ...base,
    reachable: true,
    state: PrinterState[asNumber(p["printer-state"]) ?? 0] ?? "unknown",
    reasons: asArray(p["printer-state-reasons"]).map(String).filter((r) => r !== "none").map(describeReason),
    message: asString(p["printer-state-message"]) || undefined,
    accepting: p["printer-is-accepting-jobs"] === true,
    queuedJobs: asNumber(p["queued-job-count"]),
    upTimeSec: upTime,
    makeAndModel: asString(p["printer-make-and-model"]),
    info: asString(p["printer-info"]),
    location: asString(p["printer-location"]),
    firmware: asArray(p["printer-firmware-string-version"]).map(String).join(", ") || undefined,
    moreInfo: asString(p["printer-more-info"]),
    supplies,
    mediaReady,
    trays,
    alerts,
    totalImpressions: asNumber(p["printer-impressions-completed"]),
    totalSheets: asNumber(p["printer-media-sheets-completed"]),
  };

  status.activeJobs = await deviceJobs(uri).catch(() => []);
  return status;
}

export async function deviceJobs(uri: string): Promise<DeviceJob[]> {
  const res = await ippRequest(uri, Op.GetJobs, {
    operation: [
      [Tag.uri, "printer-uri", uri],
      [Tag.nameWithoutLanguage, "requesting-user-name", "print-thing"],
      [Tag.keyword, "which-jobs", "not-completed"],
      [Tag.integer, "limit", 20],
      [Tag.keyword, "requested-attributes", [
        "job-id", "job-name", "job-originating-user-name", "job-state", "job-state-reasons", "job-state-message",
        "job-impressions-completed", "job-media-sheets-completed", "time-at-creation",
      ]],
    ],
  }, { timeoutMs: 3000 });
  return res.job.map((j) => ({
    id: asNumber(j["job-id"]) ?? 0,
    name: asString(j["job-name"]),
    user: asString(j["job-originating-user-name"]),
    state: JobState[asNumber(j["job-state"]) ?? 0] ?? "unknown",
    reasons: asArray(j["job-state-reasons"]).map(String),
    message: asString(j["job-state-message"]) || undefined,
    impressionsCompleted: asNumber(j["job-impressions-completed"]),
    sheetsCompleted: asNumber(j["job-media-sheets-completed"]),
    createdAt: asNumber(j["time-at-creation"]),
  }));
}
