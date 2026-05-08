/**
 * POST /api/console/enqueue
 * Body: { jobIds: string[] }
 *
 * Moves the given Console jobs from `captured` (or `failed`-but-user-clicked-Apply)
 * to `queued` with `lane: "primary"`. The worker dispatcher pulls from primary
 * first; only when primary is empty does it pull from retry. Concurrency is
 * capped at MAX_PARALLEL=2 in the worker — see autoapply-worker dispatcher PR.
 *
 * This route ONLY mutates Console state. It does not call the worker directly;
 * the worker's dispatcher polls/streams Console state and picks up queued rows
 * on its own. Decoupling lets the worker scale independently and lets the
 * Console-side write succeed even when the worker is down.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getConsoleJob, saveConsoleJob } from "@/lib/console";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;

  let body: { jobIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.jobIds) ? body.jobIds.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "jobIds (non-empty array of strings) is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const enqueued: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of ids) {
    const job = await getConsoleJob(email, id);
    if (!job) {
      skipped.push({ id, reason: "not found" });
      continue;
    }
    if (job.state !== "captured") {
      skipped.push({ id, reason: `state is ${job.state}, must be captured` });
      continue;
    }
    job.state = "queued";
    job.queueLane = "primary";
    job.queuedAt = now;
    await saveConsoleJob(email, job);
    enqueued.push(id);
  }

  return NextResponse.json({ enqueued, skipped, count: enqueued.length });
}
