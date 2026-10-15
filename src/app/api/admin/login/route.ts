import { NextResponse } from "next/server";
import { checkPassword, createSession, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

// Simple in-memory brute-force protection: 10 attempts per 15 minutes per IP.
const attempts = new Map<string, { count: number; reset: number }>();

export async function POST(req: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "ADMIN_PASSWORD is not set on the server, so admin login is disabled." }, { status: 503 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.reset > now && a.count >= 10) {
    return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !(await checkPassword(password))) {
    attempts.set(ip, a && a.reset > now ? { ...a, count: a.count + 1 } : { count: 1, reset: now + 15 * 60_000 });
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }
  attempts.delete(ip);
  const s = await createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, s.value, {
    httpOnly: true, sameSite: "strict", path: "/", maxAge: s.maxAge,
    secure: process.env.COOKIE_SECURE === "true",
  });
  return res;
}
