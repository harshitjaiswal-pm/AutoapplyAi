/**
 * POST /api/applications/[id]/reject
 *
 * Flips a submission from `reviewStatus="awaiting_review"` to "rejected"
 * AND marks status="failed" with a stoppedReason indicating the user
 * declined the tailored resume. Terminal state — the worker, on detecting
 * this, exits without touching Workday.
 *
 * Optional body: { reason?: string }. Free-form; gets stored in
 * stoppedReason for visibility on the dashboard.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, submissionKey } from "@/lib/redis";
import { getSubmission, type SubmissionRecord } from "@/lib/submissions";

const SUBMISSION_TTL_SECONDS = 60 * 60 * 24 * 90;

interface RejectBody {
  reason?: unknown;
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const { id } = ctx.params;

  let body: RejectBody = {};
  try {
    body = (await req.json()) as RejectBody;
  } catch {
    // Empty body is fine — reason is optional.
    body = {};
  }
  const reason =
    typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;

  const existing = await getSubmission(email, id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.userId !== email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Idempotent.
  if (existing.reviewStatus === "rejected") {
    return NextResponse.json({ submission: existing });
  }
  if (existing.reviewStatus === "approved") {
    return NextResponse.json(
      { error: "Submission was already approved — wizard may already be running." },
      { status: 409 }
    );
  }
  if (existing.reviewStatus !== "awaiting_review") {
    return NextResponse.json(
      {
        error:
          "Application is not awaiting review. The worker may not have reached the review gate yet, or this is a legacy pre-gate run.",
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const stoppedReason = reason
    ? `Rejected by user during review: ${reason}`
    : "Rejected by user during review";

  const next: SubmissionRecord = {
    ...existing,
    reviewStatus: "rejected",
    reviewStatusAt: now,
    status: "failed",
    completedAt: now,
    stoppedReason,
    currentActivity: undefined,
    currentActivityAt: undefined,
  };
  await redis.set(submissionKey(email, id), next, { ex: SUBMISSION_TTL_SECONDS });
  return NextResponse.json({ submission: next });
}
