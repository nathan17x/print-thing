import { NextResponse } from "next/server";
import { probe } from "@/lib/device";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!address?.trim()) return NextResponse.json({ error: "Enter an IP address, hostname or ipp:// URI" }, { status: 400 });
  try {
    return NextResponse.json(await probe(address));
  } catch (e) {
    const err = e as Error & { attempts?: unknown };
    return NextResponse.json({ error: err.message, attempts: err.attempts ?? [] }, { status: 422 });
  }
}
