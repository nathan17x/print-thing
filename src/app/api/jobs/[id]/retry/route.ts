import { NextResponse } from "next/server";
import { retry } from "@/lib/pipeline";
import { clientId, errorResponse } from "@/lib/server";
import { getJob } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (getJob(id)?.clientId !== (await clientId())) return errorResponse("You can only manage jobs sent from this browser", 403);
    const jobs = retry(id, await clientId());
    return NextResponse.json({ jobs });
  } catch (e) {
    return errorResponse(e);
  }
}
