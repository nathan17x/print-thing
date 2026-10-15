"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import {
  CheckCircle2Icon, ChevronDownIcon, Loader2Icon, LogOutIcon, MoreHorizontalIcon, PencilIcon, PlusIcon,
  RadarIcon, StarIcon, Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetcher, Printer, postJson } from "@/lib/client";
import type { PrinterCapabilities } from "@/lib/db";
import { cn } from "@/lib/utils";
import { PrinterDetails, PrinterHealth, SupplyBars } from "./printer-status";

interface ProbeResult { uri: string; capabilities: PrinterCapabilities; suggestedName?: string; location?: string }

export function AdminApp() {
  const router = useRouter();
  const { data, mutate, isLoading, error } = useSWR<{ printers: Printer[] }>("/api/admin/printers", fetcher, { refreshInterval: 5000 });
  const [editing, setEditing] = useState<Printer | "new" | null>(null);
  const [deleting, setDeleting] = useState<Printer | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (error?.message === "Not authenticated") {
    router.replace("/admin/login");
  }

  async function logout() {
    await postJson("/api/admin/logout");
    router.replace("/admin/login");
  }

  async function run(p: Printer, label: string, fn: () => Promise<unknown>) {
    setBusyId(p.id);
    try {
      await fn();
      toast.success(label);
      await mutate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }
  const action = (p: Printer, a: string, label: string) => run(p, label, () => postJson(`/api/admin/printers/${p.id}/action`, { action: a }));
  const patch = (p: Printer, body: object, label: string) => run(p, label, () => postJson(`/api/admin/printers/${p.id}`, body, "PATCH"));

  const printers = data?.printers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Printers</h1>
          <p className="text-sm text-muted-foreground">Printers are added as driverless IPP Everywhere queues.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={logout}><LogOutIcon className="size-4" />Sign out</Button>
          <Button onClick={() => setEditing("new")}><PlusIcon className="size-4" />Add printer</Button>
        </div>
      </div>

      {isLoading && <div className="h-32 animate-pulse rounded-xl bg-muted" />}
      {!isLoading && !printers.length && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="font-medium">No printers configured</p>
            <p className="max-w-sm text-sm text-muted-foreground">Add a printer by its IP address or hostname. HP printers usually answer at <code className="font-mono">ipp://&lt;ip&gt;/ipp/print</code> — the app will find it.</p>
            <Button onClick={() => setEditing("new")}><PlusIcon className="size-4" />Add printer</Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {printers.map((p) => (
          <Card key={p.id} className={cn(!p.enabled && "opacity-70")}>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div className="min-w-0 space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {p.name}
                  {p.isDefault && <Badge variant="secondary"><StarIcon className="size-3" />Default</Badge>}
                  {!p.enabled && <Badge variant="outline">Disabled</Badge>}
                </CardTitle>
                <CardDescription className="space-x-2">
                  <span>{p.capabilities.makeAndModel ?? "Unknown model"}</span>
                  {p.location && <span>· {p.location}</span>}
                </CardDescription>
                <code className="block truncate font-mono text-[11px] text-muted-foreground">{p.uri} → queue “{p.id}”</code>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <PrinterHealth printer={p} />
                {busyId === p.id && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="size-8" aria-label="Actions"><MoreHorizontalIcon className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => setEditing(p)}><PencilIcon />Edit</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => action(p, "refresh", "Status refreshed")}>Refresh status</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => action(p, "reprobe", "Capabilities updated")}>Re-detect capabilities</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => action(p, "resume", "Queue resumed")}>Resume stopped queue</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => action(p, "rebuild", "Queue rebuilt")}>Rebuild CUPS queue</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {!p.isDefault && <DropdownMenuItem onClick={() => patch(p, { isDefault: true }, "Default printer set")}><StarIcon />Make default</DropdownMenuItem>}
                    <DropdownMenuItem onClick={() => patch(p, { enabled: !p.enabled }, p.enabled ? "Printer disabled" : "Printer enabled")}>
                      {p.enabled ? "Disable" : "Enable"}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(p)}><Trash2Icon />Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <SupplyBars printer={p} compact />
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">{p.capabilities.colorSupported ? "Color" : "Mono"}</Badge>
                <Badge variant="outline">{p.capabilities.sidesSupported?.some((s) => s.startsWith("two")) ? "Duplex" : "Simplex only"}</Badge>
                {p.capabilities.documentFormats?.filter((f) => /pdf|urf|pwg|jpeg|postscript/.test(f)).map((f) => (
                  <Badge key={f} variant="outline" className="font-mono text-[10px]">{f}</Badge>
                ))}
              </div>
              <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded === p.id && "rotate-180")} />
                {expanded === p.id ? "Hide" : "Show"} full status
              </button>
              {expanded === p.id && <div className="rounded-lg border p-4"><PrinterDetails printer={p} /></div>}
            </CardContent>
          </Card>
        ))}
      </div>

      {editing && (
        <PrinterDialog
          printer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void mutate(); }}
        />
      )}

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>The CUPS queue will be removed. Past job history stays visible.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => {
              const p = deleting!;
              setDeleting(null);
              void run(p, "Printer deleted", () => postJson(`/api/admin/printers/${p.id}`, undefined, "DELETE"));
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PrinterDialog({ printer, onClose, onSaved }: { printer: Printer | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !printer;
  const [address, setAddress] = useState(printer?.uri ?? "");
  const [name, setName] = useState(printer?.name ?? "");
  const [location, setLocation] = useState(printer?.location ?? "");
  const [description, setDescription] = useState(printer?.description ?? "");
  const [isDefault, setIsDefault] = useState(printer?.isDefault ?? false);
  const [probed, setProbed] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function doProbe() {
    setProbing(true);
    setProbeError(null);
    setProbed(null);
    try {
      const r = await postJson<ProbeResult>("/api/admin/probe", { address });
      setProbed(r);
      setAddress(r.uri);
      if (!name && r.suggestedName) setName(r.suggestedName);
      if (!location && r.location) setLocation(r.location);
    } catch (e) {
      setProbeError((e as Error).message);
    } finally {
      setProbing(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const body = { name, uri: address, location, description, isDefault };
      if (isNew) await postJson("/api/admin/printers", body);
      else await postJson(`/api/admin/printers/${printer.id}`, body, "PATCH");
      toast.success(isNew ? "Printer added" : "Printer updated");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const caps = probed?.capabilities;
  const canSave = name.trim() && address.trim() && (!isNew || probed) && !saving;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add printer" : `Edit ${printer.name}`}</DialogTitle>
          <DialogDescription>
            Enter the printer’s IP, hostname or full <code className="font-mono">ipp://</code> URI, then detect it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="addr">Address</Label>
            <div className="flex gap-2">
              <Input id="addr" placeholder="192.168.1.50 or ipp://printer.local/ipp/print" value={address}
                onChange={(e) => { setAddress(e.target.value); setProbed(null); }}
                onKeyDown={(e) => e.key === "Enter" && doProbe()} />
              <Button variant="secondary" onClick={doProbe} disabled={!address.trim() || probing}>
                {probing ? <Loader2Icon className="size-4 animate-spin" /> : <RadarIcon className="size-4" />}Detect
              </Button>
            </div>
            {probeError && <pre className="whitespace-pre-wrap rounded-md bg-red-500/10 p-2 text-xs text-red-300">{probeError}</pre>}
            {caps && (
              <div className="space-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                <p className="flex items-center gap-1.5 font-medium text-emerald-300"><CheckCircle2Icon className="size-3.5" />Found {caps.makeAndModel ?? "printer"}</p>
                <p className="text-muted-foreground">
                  {caps.colorSupported ? "Color" : "Black & white"} · {caps.sidesSupported?.some((s) => s.startsWith("two")) ? "double-sided" : "single-sided only"}
                  {caps.ppm ? ` · ${caps.ppm} ppm` : ""}{caps.firmware ? ` · firmware ${caps.firmware}` : ""}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">{probed?.uri}</p>
              </div>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Display name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Office LaserJet" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc">Location</Label>
              <Input id="loc" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="2nd floor" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="desc">Notes</Label>
            <Textarea id="desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="def">Default printer</Label>
            <Switch id="def" checked={isDefault} onCheckedChange={setIsDefault} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>
            {saving && <Loader2Icon className="size-4 animate-spin" />}
            {isNew ? "Add printer" : "Save changes"}
          </Button>
        </DialogFooter>
        {saving && isNew && <p className="text-center text-xs text-muted-foreground">Creating the print queue — CUPS is querying the printer, this can take ~10s.</p>}
      </DialogContent>
    </Dialog>
  );
}
