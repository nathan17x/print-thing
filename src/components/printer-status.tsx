"use client";

import { AlertTriangleIcon, CircleAlertIcon, InfoIcon, LayersIcon, ServerIcon, WifiOffIcon } from "lucide-react";
import { DOT_CLASSES, formatDuration, Printer, printerTone, timeAgo, Tone } from "@/lib/client";
import { cn } from "@/lib/utils";
import { describeReason } from "@/lib/reasons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2.5">
      {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOT_CLASSES[tone])} />}
      <span className={cn("relative inline-flex size-2.5 rounded-full", DOT_CLASSES[tone])} />
    </span>
  );
}

export function PrinterHealth({ printer }: { printer: Printer }) {
  const { tone, label } = printerTone(printer);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <StatusDot tone={tone} pulse={tone === "busy"} />
      {label}
    </span>
  );
}

export function SupplyBars({ printer, compact }: { printer: Printer; compact?: boolean }) {
  const supplies = printer.device?.supplies ?? [];
  if (!supplies.length) return compact ? null : <p className="text-xs text-muted-foreground">No supply information reported.</p>;
  return (
    <div className={cn("grid gap-1.5", compact ? "grid-cols-4" : "grid-cols-1")}>
      {supplies.map((s, i) => {
        const low = s.level !== null && s.low !== null && s.level <= s.low;
        const bar = (
          <div key={i} className="min-w-0">
            {!compact && (
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{s.name}</span>
                <span className={cn("tabular-nums", low ? "text-amber-300" : "text-muted-foreground")}>
                  {s.level === null ? "unknown" : `${s.level}%`}{low && " · low"}
                </span>
              </div>
            )}
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${s.level ?? 0}%`, background: s.color === "#000000" || s.color === "#1a1a1a" ? "#d4d4d4" : s.color }}
              />
            </div>
          </div>
        );
        return compact ? (
          <Tooltip key={i}>
            <TooltipTrigger asChild><div>{bar}</div></TooltipTrigger>
            <TooltipContent>{s.name}: {s.level === null ? "unknown" : `${s.level}%`}</TooltipContent>
          </Tooltip>
        ) : bar;
      })}
    </div>
  );
}

const SEV_ICON = { error: CircleAlertIcon, warning: AlertTriangleIcon, report: InfoIcon, info: InfoIcon };
const SEV_CLASS = { error: "text-red-300", warning: "text-amber-300", report: "text-sky-300", info: "text-muted-foreground" };

export function PrinterReasons({ printer }: { printer: Printer }) {
  const d = printer.device;
  const q = printer.queue;
  const items: { sev: keyof typeof SEV_ICON; text: string; code?: string }[] = [];
  if (d && !d.reachable) items.push({ sev: "error", text: `Printer unreachable: ${d.error ?? "no response"}` });
  d?.reasons.forEach((r) => items.push({ sev: r.severity, text: r.text, code: r.keyword }));
  if (q?.error) items.push({ sev: "error", text: `Print server queue: ${q.error}` });
  else if (q && q.state === "stopped") items.push({ sev: "error", text: `Print server queue is stopped${q.message ? `: ${q.message}` : ""}`, code: "queue-stopped" });
  else if (q && !q.accepting) items.push({ sev: "warning", text: "Print server queue is not accepting jobs" });
  q?.reasons.filter((r) => !d?.reasons.some((x) => x.keyword === r)).forEach((r) => {
    const x = describeReason(r);
    items.push({ sev: x.severity, text: `Print server: ${x.text}`, code: r });
  });
  if (d?.message) items.push({ sev: "info", text: `Printer says: “${d.message}”` });
  d?.alerts.forEach((a) => items.push({ sev: "report", text: a }));

  if (!items.length) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => {
        const Icon = SEV_ICON[it.sev];
        return (
          <li key={i} className={cn("flex items-start gap-2 text-xs", SEV_CLASS[it.sev])}>
            <Icon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {it.text}
              {it.code && <code className="ml-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{it.code}</code>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function PrinterDetails({ printer }: { printer: Printer }) {
  const d = printer.device;
  const c = printer.capabilities;
  return (
    <div className="space-y-5">
      <PrinterReasons printer={printer} />

      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Supplies
        </h4>
        <SupplyBars printer={printer} />
      </section>

      {(d?.trays.length || d?.mediaReady.length) ? (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <LayersIcon className="size-3.5" /> Paper
          </h4>
          {d?.trays.map((t, i) => (
            <Row key={i} label={t.name}>{t.level ?? "—"}{t.state && t.state !== "0" ? ` · status ${t.state}` : ""}</Row>
          ))}
          {d?.mediaReady.map((m, i) => <Row key={`m${i}`} label="Loaded">{m}</Row>)}
        </section>
      ) : null}

      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <ServerIcon className="size-3.5" /> Device
        </h4>
        <div className="divide-y divide-border/60">
          <Row label="Model">{d?.makeAndModel ?? c.makeAndModel ?? "—"}</Row>
          <Row label="Device state">{d?.reachable ? d.state : <span className="inline-flex items-center gap-1 text-red-300"><WifiOffIcon className="size-3" />offline</span>}</Row>
          <Row label="Print server queue">{printer.queue ? `${printer.queue.state}${printer.queue.accepting ? "" : " · rejecting"}${printer.queue.queuedJobs ? ` · ${printer.queue.queuedJobs} queued` : ""}` : "—"}</Row>
          {d?.queuedJobs !== undefined && <Row label="Jobs at printer">{d.queuedJobs}</Row>}
          <Row label="Color">{c.colorSupported ? "Yes" : "Black & white only"}</Row>
          <Row label="Double-sided">{c.sidesSupported?.some((s) => s.startsWith("two")) ? "Yes" : "No"}</Row>
          {(c.ppm || c.ppmColor) && <Row label="Speed">{c.ppm ? `${c.ppm} ppm` : ""}{c.ppmColor ? ` · ${c.ppmColor} ppm color` : ""}</Row>}
          {d?.totalImpressions !== undefined && <Row label="Lifetime pages">{d.totalImpressions.toLocaleString()}</Row>}
          {d?.upTimeSec !== undefined && <Row label="Uptime">{formatDuration(d.upTimeSec * 1000)}</Row>}
          {(d?.firmware ?? c.firmware) && <Row label="Firmware">{d?.firmware ?? c.firmware}</Row>}
          <Row label="Address"><code className="font-mono text-[11px]">{printer.uri}</code></Row>
          {d?.moreInfo && <Row label="Web page"><a className="underline underline-offset-2" href={d.moreInfo} target="_blank" rel="noreferrer">Open</a></Row>}
          {d && <Row label="Checked">{timeAgo(d.checkedAt)}</Row>}
        </div>
      </section>
    </div>
  );
}
