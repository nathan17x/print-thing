import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { CLIENT_COOKIE } from "./auth";
import { getPrinter, PrinterRow } from "./db";
import { state } from "./pipeline";

export async function clientId() {
  return (await cookies()).get(CLIENT_COOKIE)?.value ?? "anonymous";
}

export function errorResponse(e: unknown, status = 400) {
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status });
}

export function printerDto(p: PrinterRow) {
  return {
    ...p,
    device: state.device[p.id] ?? null,
    queue: state.queue[p.id] ?? null,
  };
}
export type PrinterDto = ReturnType<typeof printerDto>;

export function slugify(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "printer";
  let id = base, n = 2;
  while (getPrinter(id)) id = `${base}-${n++}`;
  return id;
}
