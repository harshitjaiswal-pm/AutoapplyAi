/**
 * POST /api/applications/[id]/approve
 *
 * Flips a submission from `reviewStatus="awaiting_review"` to "approved".
 * The worker (running on this user's machine for smoke runs, or the Railway
 * dispatcher for autonomous runs) polls for this state change and resumes
 * the wizard + submit flow on approval. No re-tailoring happens — phase 2
 * uses the already-saved tailoredResumeJson + resumeUrl.
 *
 * Idempotent: approving an already-approved record is a no-op (returns
 * 200 with the unchanged record). Approving a rejected record is rejected
 * (terminal state — user has to retrigger if they changed their mind).
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, submissionKey } from "@/lib/redis";
import { getSubmission, type SubmissionRecord } from "@/lib/submissions";

const SUBMISSION_TTL_SECONDS = 60 * 60 * 24 * 90;

export async function POST(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const { id } = ctx.params;

  const existing = await getSubmission(email, id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.userId !== email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Idempotent for already-approved.
  if (existing.reviewStatus === "approved") {
    return NextResponse.json({ submission: existing });
  }
  // Terminal — user must retrigger via /retrigger to reconsider.
  if (existing.reviewStatus === "rejected") {
    return NextResponse.json(
      { error: "Submission was rejected — use Retrigger to start a new application." },
      { status: 409 }
    );
  }
  // Only awaiting_review can transition to approved. Anything else means the
  // worker hasn't reached the gate yet, or has already moved past it.
  if (existing.reviewStatus !== "awaiting_review") {
    return NextResponse.json(
      {
        error:
          "Application is not awaiting review. The worker may not have reached the review gate yet, or this is a legacy pre-gate run.",
      },
      { status: 409 }
    );
  }

  const next: SubmissionRecord = {
    ...existing,
    reviewStatus: "approved",
    reviewStatusAt: new Date().toISOString(),
  };
  await redis.set(submissionKey(email, id), next, { ex: SUBMISSION_TTL_SECONDS });
  return NextResponse.json({ submission: next });
}
