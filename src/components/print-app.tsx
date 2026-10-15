"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  CheckIcon, FileIcon, FileImageIcon, FileSpreadsheetIcon, FileTextIcon, Loader2Icon, PaletteIcon,
  PrinterIcon, RefreshCwIcon, UploadCloudIcon, XIcon, CircleAlertIcon, CopyIcon, InfoIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetcher, formatBytes, Printer, postJson, printerTone } from "@/lib/client";
import { cn } from "@/lib/utils";
import { PrinterDetails, PrinterHealth, PrinterReasons, SupplyBars } from "./printer-status";
import { JobsPanel } from "./jobs-panel";

interface QueuedFile {
  key: string;
  file: File;
  status: "uploading" | "ready" | "error";
  progress: number;
  uploadId?: string;
  pages?: number | null;
  label?: string;
  kind?: string;
  error?: string;
}

type Sides = "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";

const LS_PRINTER = "print.printer";

function uploadFile(file: File, onProgress: (p: number) => void) {
  return new Promise<{ id: string; pages: number | null; label: string; kind: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { error?: string } & Record<string, unknown> = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as never);
      else reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open("POST", "/api/uploads");
    xhr.send(form);
  });
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "avif"].includes(ext)) return FileImageIcon;
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return FileSpreadsheetIcon;
  if (["pdf", "doc", "docx", "odt", "rtf", "txt", "md"].includes(ext)) return FileTextIcon;
  return FileIcon;
}

export function PrintApp() {
  const { data, mutate: refreshPrinters, isLoading } = useSWR<{ printers: Printer[] }>("/api/printers", fetcher, { refreshInterval: 4000 });
  const printers = useMemo(() => data?.printers ?? [], [data]);

  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [printerId, setPrinterId] = useState<string | null>(null);
  const [color, setColor] = useState<"color" | "monochrome">("color");
  const [sides, setSides] = useState<Sides>("one-sided");
  const [copies, setCopies] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [detailsFor, setDetailsFor] = useState<Printer | null>(null);
  const [jobsKey, setJobsKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Choose remembered → default → first printer.
  useEffect(() => {
    if (!printers.length || (printerId && printers.some((p) => p.id === printerId))) return;
    let saved: string | null = null;
    try { saved = localStorage.getItem(LS_PRINTER); } catch {}
    const pick = printers.find((p) => p.id === saved) ?? printers.find((p) => p.isDefault) ?? printers[0];
    setPrinterId(pick.id);
  }, [printers, printerId]);

  const printer = printers.find((p) => p.id === printerId) ?? null;
  const canColor = printer?.capabilities.colorSupported !== false;
  const duplexModes = (printer?.capabilities.sidesSupported ?? []).filter((s) => s.startsWith("two-sided"));
  const canDuplex = duplexModes.length > 0;

  useEffect(() => {
    if (!canColor) setColor("monochrome");
    if (!canDuplex) setSides("one-sided");
  }, [canColor, canDuplex]);

  const selectPrinter = (id: string) => {
    setPrinterId(id);
    try { localStorage.setItem(LS_PRINTER, id); } catch {}
  };

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list).map<QueuedFile>((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file, status: "uploading", progress: 0,
    }));
    if (!incoming.length) return;
    setFiles((f) => [...f, ...incoming]);
    // Upload up to 3 at a time.
    const queue = [...incoming];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const key = item.key;
        try {
          const res = await uploadFile(item.file, (progress) =>
            setFiles((f) => f.map((x) => (x.key === key ? { ...x, progress } : x))));
          setFiles((f) => f.map((x) => x.key === key ? {
            ...x, status: res.kind === "unsupported" ? "error" : "ready", progress: 100, uploadId: res.id,
            pages: res.pages, label: res.label, kind: res.kind,
            error: res.kind === "unsupported" ? "This file type can't be printed" : undefined,
          } : x));
        } catch (e) {
          setFiles((f) => f.map((x) => (x.key === key ? { ...x, status: "error", error: (e as Error).message } : x)));
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
  }, []);

  const removeFile = (key: string) => {
    const f = files.find((x) => x.key === key);
    setFiles((list) => list.filter((x) => x.key !== key));
    if (f?.uploadId) void fetch(`/api/uploads/${f.uploadId}`, { method: "DELETE" });
  };

  // Paste files from the clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.files ?? []);
      if (items.length) addFiles(items);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  const ready = files.filter((f) => f.status === "ready");
  const uploading = files.some((f) => f.status === "uploading");
  const totalPages = ready.reduce((n, f) => n + (f.pages ?? 0), 0);
  const unknownPages = ready.some((f) => f.pages == null);
  const printerTn = printer ? printerTone(printer) : null;

  async function print() {
    if (!printer || !ready.length) return;
    setSubmitting(true);
    try {
      await postJson("/api/print", {
        uploadIds: ready.map((f) => f.uploadId),
        printerId: printer.id,
        options: { color, sides, copies },
      });
      toast.success(`Sent ${ready.length} file${ready.length === 1 ? "" : "s"} to ${printer.name}`);
      setFiles((f) => f.filter((x) => x.status !== "ready"));
      setJobsKey((k) => k + 1);
      document.getElementById("jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* ---------- Files ---------- */}
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>PDF, Word, Excel, PowerPoint, images, text and more. You can also paste.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
              onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
              onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(e.dataTransfer.files); }}
              className={cn(
                "group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-all",
                dragging ? "border-sky-400 bg-sky-400/10" : "border-border hover:border-muted-foreground/50 hover:bg-muted/30",
              )}
            >
              <div className={cn("grid size-14 place-items-center rounded-full bg-muted transition-transform", dragging && "scale-110")}>
                <UploadCloudIcon className="size-7 text-muted-foreground group-hover:text-foreground" />
              </div>
              <div>
                <p className="font-medium">{dragging ? "Drop to add" : "Drag & drop files here"}</p>
                <p className="text-sm text-muted-foreground">or click to browse — as many as you like</p>
              </div>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
              />
            </div>

            {files.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {files.length} file{files.length === 1 ? "" : "s"}
                    {ready.length > 0 && ` · ${totalPages}${unknownPages ? "+" : ""} page${totalPages === 1 && !unknownPages ? "" : "s"}`}
                  </span>
                  <button className="hover:text-foreground" onClick={() => files.forEach((f) => removeFile(f.key))}>Clear all</button>
                </div>
                <ul className="divide-y rounded-lg border">
                  {files.map((f) => {
                    const Icon = fileIcon(f.file.name);
                    return (
                      <li key={f.key} className="flex items-center gap-3 px-3 py-2.5">
                        <Icon className="size-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium">{f.file.name}</p>
                            {f.status === "ready" && <CheckIcon className="size-3.5 shrink-0 text-emerald-400" />}
                          </div>
                          {f.status === "uploading" ? (
                            <div className="mt-1.5 flex items-center gap-2">
                              <Progress value={f.progress} className="h-1" />
                              <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{f.progress}%</span>
                            </div>
                          ) : f.status === "error" ? (
                            <p className="flex items-center gap-1 text-xs text-red-300"><CircleAlertIcon className="size-3" />{f.error}</p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {f.label} · {formatBytes(f.file.size)}
                              {f.pages != null && ` · ${f.pages} page${f.pages === 1 ? "" : "s"}`}
                              {f.kind && f.kind !== "native" && " · will be converted"}
                            </p>
                          )}
                        </div>
                        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => removeFile(f.key)} aria-label="Remove">
                          <XIcon className="size-4" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---------- Printer + options ---------- */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Printer</CardTitle>
                <CardDescription>Live status from the printer</CardDescription>
              </div>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => refreshPrinters()} aria-label="Refresh">
                <RefreshCwIcon className="size-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {isLoading && <div className="h-20 animate-pulse rounded-lg bg-muted" />}
              {!isLoading && !printers.length && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No printers yet. An administrator can add one on the <a href="/admin" className="underline">admin page</a>.
                </div>
              )}
              {printers.map((p) => {
                const selected = p.id === printerId;
                return (
                  <div
                    key={p.id}
                    role="radio"
                    aria-checked={selected}
                    tabIndex={0}
                    onClick={() => selectPrinter(p.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && selectPrinter(p.id)}
                    className={cn(
                      "w-full cursor-pointer rounded-lg border p-3 text-left transition-colors",
                      selected ? "border-sky-400/70 bg-sky-400/5 ring-1 ring-sky-400/40" : "hover:bg-muted/40",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{p.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {p.location || p.capabilities.makeAndModel || p.uri}
                        </p>
                      </div>
                      <PrinterHealth printer={p} />
                    </div>
                    <div className="mt-2.5"><SupplyBars printer={p} compact /></div>
                    {selected && (
                      <div className="mt-3 space-y-2">
                        <PrinterReasons printer={p} />
                        <button
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          onClick={(e) => { e.stopPropagation(); setDetailsFor(p); }}
                        >
                          <InfoIcon className="size-3" /> Full printer details
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Options</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5"><PaletteIcon className="size-3.5" /> Color</Label>
                <Segmented
                  value={color}
                  onChange={(v) => setColor(v as "color" | "monochrome")}
                  options={[
                    { value: "color", label: "Color", disabled: !canColor },
                    { value: "monochrome", label: "Black & white" },
                  ]}
                />
                {!canColor && printer && <p className="text-xs text-muted-foreground">This printer only prints in black & white.</p>}
              </div>
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5"><CopyIcon className="size-3.5" /> Sides</Label>
                <Segmented
                  value={sides === "one-sided" ? "one-sided" : "two"}
                  onChange={(v) => setSides(v === "one-sided" ? "one-sided" : (duplexModes.includes("two-sided-long-edge") ? "two-sided-long-edge" : "two-sided-short-edge"))}
                  options={[
                    { value: "one-sided", label: "One-sided" },
                    { value: "two", label: "Double-sided", disabled: !canDuplex },
                  ]}
                />
                {sides !== "one-sided" && duplexModes.length > 1 && (
                  <Segmented
                    size="sm"
                    value={sides}
                    onChange={(v) => setSides(v as Sides)}
                    options={[
                      { value: "two-sided-long-edge", label: "Flip on long edge" },
                      { value: "two-sided-short-edge", label: "Flip on short edge" },
                    ]}
                  />
                )}
                {!canDuplex && printer && <p className="text-xs text-muted-foreground">This printer doesn’t support double-sided printing.</p>}
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="copies">Copies</Label>
                <Input
                  id="copies" type="number" min={1} max={99} value={copies} className="w-20 text-right"
                  onChange={(e) => setCopies(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                />
              </div>
            </CardContent>
          </Card>

          <Button
            size="lg"
            className="h-12 w-full text-base"
            disabled={!printer || !ready.length || submitting || uploading}
            onClick={print}
          >
            {submitting ? <Loader2Icon className="size-5 animate-spin" /> : <PrinterIcon className="size-5" />}
            {uploading ? "Uploading…" : ready.length ? `Print ${ready.length} file${ready.length === 1 ? "" : "s"}` : "Add files to print"}
          </Button>
          {printer && printerTn && (printerTn.tone === "error") && ready.length > 0 && (
            <p className="-mt-3 text-center text-xs text-amber-300">
              {printer.name} reports a problem — jobs will wait until it’s fixed.
            </p>
          )}
        </div>
      </div>

      <JobsPanel refreshKey={jobsKey} />

      <Dialog open={!!detailsFor} onOpenChange={(o) => !o && setDetailsFor(null)}>
        <DialogContent className="max-h-[85vh] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              {detailsFor?.name}
              {detailsFor && <Badge variant="outline"><PrinterHealth printer={printers.find((p) => p.id === detailsFor.id) ?? detailsFor} /></Badge>}
            </DialogTitle>
            <DialogDescription>{detailsFor?.location || detailsFor?.capabilities.makeAndModel}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh] pr-3">
            {detailsFor && <PrinterDetails printer={printers.find((p) => p.id === detailsFor.id) ?? detailsFor} />}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Segmented({ value, onChange, options, size }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  size?: "sm";
}) {
  return (
    <div className="grid rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            size === "sm" ? "py-1 text-xs" : "py-1.5 text-sm",
            value === o.value ? "bg-background text-foreground shadow-sm ring-1 ring-white/15" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
