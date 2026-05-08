/**
 * POST /api/applications/[id]/retrigger
 *
 * Creates a new ConsoleJob for the submission's job URL and enqueues
 * it on the retry lane so the dispatcher picks it up. Returns the new
 * ConsoleJob id so the caller can deep-link to /console (in a new tab,
 * typically) and watch the run from `queued → running → submitted/failed`.
 *
 * Why a new ConsoleJob instead of re-running the existing applicationId?
 *   - The Console state machine owns the queue. Existing applicationIds
 *     are historical worker records — re-running would mutate that
 *     history, which violates the dashboard-as-historical-record
 *     contract we settled on.
 *   - A retry generates a brand-new applicationId, leaving the failed
 *     attempt visible alongside the new one. User can compare what
 *     went wrong vs what worked.
 *
 * Budget gate matches /api/console/enqueue — refuse with HTTP 402 if the
 * user is at/over their monthly cap. No point queueing a job we'll bounce
 * at tailor time.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { randomUUID } from "node:crypto";
import { getSubmission } from "@/lib/submissions";
import {
  type ConsoleJob,
  canonicalizeUrl,
  detectAts,
  findByUrl,
  saveConsoleJob,
} from "@/lib/console";
import { getBudgetStatus } from "@/lib/budget";

export async function POST(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const { id } = ctx.params;

  const submission = await getSubmission(email, id);
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (submission.userId !== email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!submission.jobUrl) {
    return NextResponse.json(
      { error: "Submission has no jobUrl to retrigger" },
      { status: 400 }
    );
  }

  // Budget gate — same rule as /api/console/enqueue.
  const budget = await getBudgetStatus(email);
  if (budget.isOver) {
    return NextResponse.json(
      {
        error: `Monthly budget exhausted: $${(budget.spendCents / 100).toFixed(2)} of $${(budget.capCents / 100).toFixed(2)} cap for ${budget.monthKey}.`,
        spendCents: budget.spendCents,
        capCents: budget.capCents,
        monthKey: budget.monthKey,
      },
      { status: 402 }
    );
  }

  const canonical = canonicalizeUrl(submission.jobUrl);
  const now = new Date().toISOString();

  // Look up an existing ConsoleJob for this canonical URL — the user may
  // have captured this URL via /console at some point, in which case we
  // re-queue that row instead of spawning a duplicate.
  const existing = await findByUrl(email, canonical);
  let job: ConsoleJob;
  if (existing) {
    job = {
      ...existing,
      state: "queued",
      queueLane: "retry",
      queuedAt: now,
      retryCount: (existing.retryCount ?? 0) + 1,
      lastSeenAt: now,
    };
  } else {
    // No prior ConsoleJob — create one from the submission's metadata so
    // the Pipeline tab has a row to render while the worker runs.
    job = {
      id: randomUUID(),
      state: "queued",
      sources: ["paste"],
      capturedAt: now,
      lastSeenAt: now,
      url: canonical,
      rawUrls: [submission.jobUrl],
      title: submission.jobTitle || "—",
      company: submission.company || submission.tenant?.split(".")[0] || "—",
      location: "",
      ats: detectAts(canonical),
      retryCount: 1,
      queueLane: "retry",
      queuedAt: now,
    };
  }
  await saveConsoleJob(email, job);

  return NextResponse.json({ jobId: job.id, state: job.state, queueLane: job.queueLane });
}
