import { NextResponse } from "next/server";
import { createJobs } from "@/lib/pipeline";
import { clientId, errorResponse } from "@/lib/server";
import type { JobOptions } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json() as { uploadIds?: string[]; printerId?: string; options?: Partial<JobOptions> };
    if (!body.uploadIds?.length) return errorResponse("Add at least one file");
    if (!body.printerId) return errorResponse("Choose a printer");
    const o = body.options ?? {};
    const options: JobOptions = {
      color: o.color === "monochrome" ? "monochrome" : "color",
      sides: o.sides === "two-sided-long-edge" || o.sides === "two-sided-short-edge" ? o.sides : "one-sided",
      copies: Number(o.copies) || 1,
    };
    const jobs = createJobs({ clientId: await clientId(), uploadIds: body.uploadIds, printerId: body.printerId, options });
    return NextResponse.json({ jobs });
  } catch (e) {
    return errorResponse(e);
  }
}
