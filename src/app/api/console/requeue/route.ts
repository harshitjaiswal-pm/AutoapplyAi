/**
 * POST /api/console/requeue
 * Body: { jobId: string }
 *
 * Re-queues a failed job for another attempt. Goes onto the `retry` lane,
 * which the worker dispatcher only drains AFTER `primary` is empty. This
 * encodes the policy: user-selected work first, retried failures only when
 * idle.
 *
 * Bumps retryCount so the dispatcher can apply backoff or hard-stop after
 * N attempts (configurable on the worker side). Clears the previous
 * applicationId — the next worker run will create a fresh one so the
 * Submissions dashboard accumulates an entry per attempt instead of
 * overwriting history.
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

  let body: { jobId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.jobId === "string" ? body.jobId : "";
  if (!id) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const job = await getConsoleJob(email, id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.state !== "failed") {
    return NextResponse.json(
      { error: `Cannot re-queue from state "${job.state}". Only failed jobs can be re-queued.` },
      { status: 409 }
    );
  }

  job.state = "queued";
  job.queueLane = "retry";
  job.queuedAt = new Date().toISOString();
  job.retryCount = (job.retryCount ?? 0) + 1;
  // Don't clear applicationId from the previous run — the worker creates a
  // fresh one on next dispatch. Keep the old one as audit trail until the
  // worker overwrites with the new run's applicationId.
  await saveConsoleJob(email, job);
  return NextResponse.json({ job });
}
