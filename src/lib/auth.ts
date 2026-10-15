// Works in both the Edge (middleware) and Node runtimes: Web Crypto only.

export const SESSION_COOKIE = "pt_admin";
export const CLIENT_COOKIE = "pt_client";
const SESSION_TTL_MS = 12 * 3600_000;

const enc = new TextEncoder();

async function key() {
  const secret = process.env.SESSION_SECRET || `print-thing:${process.env.ADMIN_PASSWORD ?? ""}`;
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(payload: string) {
  return toHex(await crypto.subtle.sign("HMAC", await key(), enc.encode(payload)));
}

export async function createSession() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return { value: `${exp}.${await sign(exp)}`, maxAge: SESSION_TTL_MS / 1000 };
}

export async function verifySession(value: string | undefined) {
  if (!value || !process.env.ADMIN_PASSWORD) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await sign(exp));
}

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkPassword(input: string) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Compare digests so length differences don't leak.
  const [a, b] = await Promise.all([sign(`pw:${input}`), sign(`pw:${expected}`)]);
  return timingSafeEqual(a, b);
}
