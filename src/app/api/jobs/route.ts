import { NextResponse } from "next/server";
import { eventsFor, listRecentJobs } from "@/lib/db";
import { clientId } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "all" ? "all" : "mine";
  const me = await clientId();
  const jobs = listRecentJobs({
    clientId: scope === "mine" ? me : undefined,
    sinceMs: Date.now() - 7 * 24 * 3600_000,
    limit: 100,
  });
  const events = eventsFor(jobs.map((j) => j.id));
  return NextResponse.json({
    jobs: jobs.map(({ clientId: owner, attrs, ...j }) => ({ ...j, mine: owner === me, attrs, events: events[j.id] ?? [] })),
  });
}
