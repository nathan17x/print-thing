import { NextRequest, NextResponse } from "next/server";
import { CLIENT_COOKIE, SESSION_COOKIE, verifySession } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isAdminApi = pathname.startsWith("/api/admin") && pathname !== "/api/admin/login";
  const isAdminPage = pathname.startsWith("/admin") && pathname !== "/admin/login";

  if (isAdminApi || isAdminPage) {
    const ok = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!ok) {
      if (isAdminApi) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  // Anonymous per-browser id so users can see "their" jobs without logging in.
  if (req.cookies.get(CLIENT_COOKIE)) return NextResponse.next();
  const id = crypto.randomUUID();
  req.cookies.set(CLIENT_COOKIE, id); // visible to this request's handlers too
  const res = NextResponse.next({ request: { headers: req.headers } });
  {
    res.cookies.set(CLIENT_COOKIE, id, {
      httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}

export const config = {
  // Node runtime so ADMIN_PASSWORD is read from the container's environment at runtime.
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
