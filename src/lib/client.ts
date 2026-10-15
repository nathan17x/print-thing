// Client-safe types and helpers (type-only imports from server modules).
import type { JobEvent, JobRow, PrinterRow } from "./db";
import type { DeviceStatus } from "./device";
import type { QueueInfo } from "./cups";

export type Printer = PrinterRow & {
  device: DeviceStatus | null;
  queue: (QueueInfo & { checkedAt: number; error?: string }) | null;
};

export type Job = Omit<JobRow, "clientId"> & { mine: boolean; events: JobEvent[] };

export const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
};

export async function postJson<T = unknown>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status})`);
  return data as T;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function timeAgo(ts: number, now = Date.now()) {
  const d = now - ts;
  if (d < 5000) return "just now";
  return `${formatDuration(d)} ago`;
}

export const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

export type Tone = "ok" | "busy" | "warn" | "error" | "muted";

export const STAGE_META: Record<string, { label: string; tone: Tone }> = {
  "queued-local": { label: "Preparing", tone: "busy" },
  converting: { label: "Converting", tone: "busy" },
  submitting: { label: "Sending", tone: "busy" },
  pending: { label: "Queued", tone: "busy" },
  held: { label: "Held", tone: "warn" },
  processing: { label: "Printing", tone: "busy" },
  stopped: { label: "Needs attention", tone: "error" },
  completed: { label: "Completed", tone: "ok" },
  canceled: { label: "Canceled", tone: "muted" },
  aborted: { label: "Aborted", tone: "error" },
  failed: { label: "Failed", tone: "error" },
};

export const TONE_CLASSES: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  busy: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  error: "bg-red-500/15 text-red-300 border-red-500/30",
  muted: "bg-muted text-muted-foreground border-border",
};

export const DOT_CLASSES: Record<Tone, string> = {
  ok: "bg-emerald-400",
  busy: "bg-sky-400",
  warn: "bg-amber-400",
  error: "bg-red-400",
  muted: "bg-neutral-500",
};

/** Overall health of a printer for a status dot. */
export function printerTone(p: Printer): { tone: Tone; label: string } {
  const d = p.device;
  if (!p.enabled) return { tone: "muted", label: "Disabled" };
  if (!d) return { tone: "muted", label: "Checking…" };
  if (!d.reachable) return { tone: "error", label: "Offline" };
  if (p.queue && (p.queue.state === "stopped" || !p.queue.accepting)) return { tone: "error", label: "Queue stopped" };
  if (d.reasons.some((r) => r.severity === "error") || d.state === "stopped") return { tone: "error", label: "Needs attention" };
  if (d.state === "processing") return { tone: "busy", label: "Printing" };
  if (d.reasons.some((r) => r.severity === "warning")) return { tone: "warn", label: "Ready (warning)" };
  return { tone: "ok", label: "Ready" };
}

export const isActive = (stage: string) =>
  ["queued-local", "converting", "submitting", "pending", "held", "processing", "stopped"].includes(stage);

export const sidesText = (s: string) =>
  s === "one-sided" ? "One-sided" : s === "two-sided-long-edge" ? "Double-sided (long edge)" : "Double-sided (short edge)";
