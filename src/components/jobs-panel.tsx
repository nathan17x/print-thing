"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  AlertTriangleIcon, BanIcon, CheckCircle2Icon, ChevronDownIcon, CircleAlertIcon, CircleIcon, ClockIcon,
  InfoIcon, Loader2Icon, PrinterIcon, RotateCcwIcon, XCircleIcon,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  fetcher, formatBytes, formatDuration, formatTime, isActive, Job, postJson, sidesText, STAGE_META, timeAgo, TONE_CLASSES,
} from "@/lib/client";
import { describeReason } from "@/lib/reasons";
import { cn } from "@/lib/utils";

export function JobsPanel({ refreshKey }: { refreshKey: number }) {
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [fast, setFast] = useState(true);
  const { data, mutate, isLoading } = useSWR<{ jobs: Job[] }>(`/api/jobs?scope=${scope}`, fetcher, {
    refreshInterval: fast ? 1500 : 6000,
  });
  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const anyActive = jobs.some((j) => isActive(j.stage));
  useEffect(() => setFast(anyActive), [anyActive]);
  useEffect(() => { if (refreshKey) { setFast(true); void mutate(); } }, [refreshKey, mutate]);

  // Re-render every second so elapsed timers tick.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  const active = jobs.filter((j) => isActive(j.stage));
  const done = jobs.filter((j) => !isActive(j.stage));

  return (
    <Card id="jobs" className="scroll-mt-20">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Print jobs</CardTitle>
          <CardDescription>
            {anyActive ? `${active.length} in progress · updating live` : "Status straight from the print server and printer"}
          </CardDescription>
        </div>
        <Tabs value={scope} onValueChange={(v) => setScope(v as "mine" | "all")}>
          <TabsList>
            <TabsTrigger value="mine">This browser</TabsTrigger>
            <TabsTrigger value="all">Everyone</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <div className="h-24 animate-pulse rounded-lg bg-muted" />}
        {!isLoading && !jobs.length && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-sm text-muted-foreground">
            <PrinterIcon className="size-6" />
            No print jobs yet
          </div>
        )}
        {active.map((j) => <JobCard key={j.id} job={j} onChange={() => mutate()} defaultOpen />)}
        {done.length > 0 && active.length > 0 && <p className="pt-2 text-xs uppercase tracking-wide text-muted-foreground">Finished</p>}
        {done.map((j) => <JobCard key={j.id} job={j} onChange={() => mutate()} />)}
      </CardContent>
    </Card>
  );
}

const STAGE_ICON: Record<string, typeof CircleIcon> = {
  completed: CheckCircle2Icon, canceled: BanIcon, aborted: XCircleIcon, failed: XCircleIcon, stopped: AlertTriangleIcon, held: ClockIcon,
};

function JobCard({ job, onChange, defaultOpen }: { job: Job; onChange: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [busy, setBusy] = useState(false);
  const trouble = !!job.stateMessage && /unavailable|not exist|unable|offline|error|jam|out of|empty|open|low|failed|cannot|not responding/i.test(job.stateMessage);
  const baseMeta = STAGE_META[job.stage] ?? { label: job.stage, tone: "muted" as const };
  const meta = trouble && ["pending", "processing"].includes(job.stage) ? { label: "Waiting on printer", tone: "warn" as const } : baseMeta;
  const active = isActive(job.stage);
  const Icon = STAGE_ICON[job.stage] ?? (active ? Loader2Icon : CircleIcon);

  const totalImpressions = job.pages ? job.pages * job.options.copies : null;
  // Prefer the printer's own count (physically printed) over the print server's (pages processed).
  const deviceImpressions = job.device?.impressionsCompleted as number | undefined;
  const fromDevice = !!deviceImpressions;
  const impressions = (fromDevice ? deviceImpressions : job.impressionsCompleted) ?? null;
  const verb = fromDevice || job.stage === "completed" ? "printed" : "processed";
  const pct = job.stage === "completed" ? 100
    : totalImpressions && impressions != null ? Math.min(100, Math.round((impressions / totalImpressions) * 100))
    : null;

  // Hide reasons that just restate the stage; once finished, keep only meaningful outcomes.
  const reasons = job.stateReasons
    .filter((r) => !["none", "job-printing", "job-queued", "job-completed-successfully"].includes(r))
    .map(describeReason)
    .filter((r) => active || r.severity === "error" || r.severity === "warning" || /^job-(completed-with|canceled)|aborted|error/.test(r.keyword));

  const started = job.processingAt ?? job.submittedAt;
  const end = job.completedAt ?? Date.now();

  async function act(action: "cancel" | "retry") {
    setBusy(true);
    try {
      await postJson(`/api/jobs/${job.id}/${action}`);
      toast.success(action === "cancel" ? "Cancel requested" : "Job resubmitted");
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("rounded-lg border transition-colors", active && "border-sky-500/30 bg-sky-500/[0.03]")}>
      <div className="flex items-start gap-3 p-3 sm:p-4">
        <Icon className={cn("mt-0.5 size-5 shrink-0", active && Icon === Loader2Icon && "animate-spin",
          { ok: "text-emerald-400", busy: "text-sky-400", warn: "text-amber-400", error: "text-red-400", muted: "text-muted-foreground" }[meta.tone])} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="min-w-0 truncate font-medium">{job.fileName}</p>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", TONE_CLASSES[meta.tone])}>{meta.label}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {job.printerName} · {job.options.color === "color" ? "Color" : "B&W"} · {sidesText(job.options.sides)}
            {job.options.copies > 1 && ` · ${job.options.copies} copies`}
            {job.pages != null && ` · ${job.pages} page${job.pages === 1 ? "" : "s"}`}
            {" · "}{timeAgo(job.createdAt)}
            {!job.mine && " · from another device"}
          </p>

          {(active || job.stage === "completed") && (
            <div className="space-y-1">
              {pct !== null ? <Progress value={pct} className="h-1.5" /> : active ? <IndeterminateBar /> : null}
              <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                <span>
                  {impressions != null && totalImpressions
                    ? `${impressions} of ${totalImpressions} pages ${verb}`
                    : impressions != null && impressions > 0 ? `${impressions} page${impressions === 1 ? "" : "s"} ${verb}`
                    : job.stage === "completed" ? "Done" : stageHint(job)}
                  {job.sheetsCompleted ? ` · ${job.sheetsCompleted} sheet${job.sheetsCompleted === 1 ? "" : "s"}` : ""}
                </span>
                {started && <span>{job.stage === "completed" ? "took " : ""}{formatDuration(end - started)}</span>}
              </div>
            </div>
          )}

          {job.error && (
            <p className="flex items-start gap-1.5 text-xs text-red-300"><CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />{job.error}</p>
          )}
          {job.stateMessage && (
            <p className={cn("flex items-start gap-1.5 text-xs", trouble ? "text-amber-300" : "text-sky-200")}>
              {trouble ? <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" /> : <InfoIcon className="mt-0.5 size-3.5 shrink-0" />}
              Printer: “{job.stateMessage}”
            </p>
          )}
          {reasons.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <span key={r.keyword} title={r.keyword} className={cn("rounded-md border px-1.5 py-0.5 text-[11px]",
                  r.severity === "error" ? TONE_CLASSES.error : r.severity === "warning" ? TONE_CLASSES.warn : TONE_CLASSES.muted)}>
                  {r.text}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.mine && active && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("cancel")}>Cancel</Button>
          )}
          {job.mine && ["failed", "aborted", "canceled"].includes(job.stage) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("retry")}><RotateCcwIcon className="size-3.5" />Retry</Button>
          )}
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setOpen((o) => !o)} aria-label="Details">
            <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} />
          </Button>
        </div>
      </div>

      {open && <JobDetails job={job} />}
    </div>
  );
}

function stageHint(job: Job) {
  switch (job.stage) {
    case "queued-local": return "Preparing…";
    case "converting": return "Converting document…";
    case "submitting": return "Sending to print server…";
    case "pending": return "Waiting for the printer…";
    case "processing": return "Printer is working…";
    case "stopped": return "Paused — printer needs attention";
    case "held": return "On hold";
    default: return "";
  }
}

function IndeterminateBar() {
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
      <div className="absolute inset-y-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-sky-400/80" />
      <style>{`@keyframes indeterminate { 0% { left: -33% } 100% { left: 100% } }`}</style>
    </div>
  );
}

const EVENT_STYLE: Record<string, { icon: typeof CircleIcon; cls: string }> = {
  info: { icon: CircleIcon, cls: "text-sky-400" },
  success: { icon: CheckCircle2Icon, cls: "text-emerald-400" },
  warn: { icon: AlertTriangleIcon, cls: "text-amber-400" },
  error: { icon: XCircleIcon, cls: "text-red-400" },
};

function JobDetails({ job }: { job: Job }) {
  const [showRaw, setShowRaw] = useState(false);
  const rows: [string, React.ReactNode][] = [
    ["Print server job", job.cupsJobId ? `#${job.cupsJobId}` : "—"],
    ["Server state", job.cupsState ?? "—"],
    ["File size", formatBytes(job.fileSize)],
    ["Format", job.mime],
    ["Created", formatTime(job.createdAt)],
    ["Sent to server", job.submittedAt ? formatTime(job.submittedAt) : "—"],
    ["Started printing", job.processingAt ? formatTime(job.processingAt) : "—"],
    ["Finished", job.completedAt ? formatTime(job.completedAt) : "—"],
    ["Wait time", job.submittedAt && job.processingAt ? formatDuration(job.processingAt - job.submittedAt) : "—"],
    ["Pages processed (server)", job.impressionsCompleted ?? "—"],
    ["Sheets used", job.sheetsCompleted ?? "—"],
    ["Data sent", job.kOctets != null ? `${job.kOctets} KB` : "—"],
  ];
  const dev = job.device as { id?: number; state?: string; impressionsCompleted?: number; message?: string } | null;
  if (dev) {
    rows.push(["Printer job", dev.id ? `#${dev.id} (${dev.state})` : "—"]);
    if (dev.impressionsCompleted != null) rows.push(["Pages printed (printer)", dev.impressionsCompleted]);
  }

  return (
    <div className="grid gap-4 border-t px-3 py-4 sm:grid-cols-2 sm:px-4">
      <div>
        <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</h4>
        <ol className="relative space-y-3 border-l border-border pl-4">
          {job.events.map((e) => {
            const s = EVENT_STYLE[e.level] ?? EVENT_STYLE.info;
            return (
              <li key={e.id} className="relative">
                <s.icon className={cn("absolute -left-[23px] top-0.5 size-3.5 bg-card", s.cls)} />
                <p className="text-xs leading-snug">{e.message}</p>
                <p className="text-[10px] tabular-nums text-muted-foreground">{formatTime(e.ts)}</p>
              </li>
            );
          })}
        </ol>
      </div>
      <div>
        <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Details</h4>
        <dl className="divide-y divide-border/60">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-1 text-xs">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {Object.keys(job.attrs ?? {}).length > 0 && (
          <div className="mt-3">
            <button className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setShowRaw((s) => !s)}>
              {showRaw ? "Hide" : "Show"} raw IPP job attributes
            </button>
            {showRaw && (
              <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
                {JSON.stringify(job.attrs, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
