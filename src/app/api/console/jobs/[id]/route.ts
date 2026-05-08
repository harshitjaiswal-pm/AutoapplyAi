/**
 * PATCH /api/console/jobs/:id — edit notes / archive / unarchive
 * DELETE /api/console/jobs/:id — hard delete (rare; usually archive instead)
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, consoleIndexKey, consoleJobKey } from "@/lib/redis";
import { getConsoleJob, saveConsoleJob } from "@/lib/console";

interface PatchBody {
  notes?: string;
  archive?: boolean;
  unarchive?: boolean;
  matchScore?: number;
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const job = await getConsoleJob(email, ctx.params.id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.notes === "string") job.notes = body.notes;
  if (typeof body.matchScore === "number") job.matchScore = body.matchScore;
  if (body.archive) {
    if (job.state === "running" || job.state === "queued") {
      return NextResponse.json(
        { error: `Cannot archive a job in state ${job.state} — re-queue is not in flight, but the worker may pick it up. Wait for it to finish.` },
        { status: 409 }
      );
    }
    job.state = "archived";
  }
  if (body.unarchive && job.state === "archived") {
    job.state = "captured";
  }
  await saveConsoleJob(email, job);
  return NextResponse.json({ job });
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const job = await getConsoleJob(email, ctx.params.id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.state === "running" || job.state === "queued") {
    return NextResponse.json(
      { error: `Cannot delete a job that is ${job.state}; archive instead, or wait until it finishes.` },
      { status: 409 }
    );
  }
  await redis.del(consoleJobKey(email, ctx.params.id));
  await redis.srem(consoleIndexKey(email), ctx.params.id);
  return NextResponse.json({ ok: true });
}
