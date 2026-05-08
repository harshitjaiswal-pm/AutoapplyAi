/**
 * GET /api/applications/[id]
 *   Returns the full submission record for one application, including
 *   screenshots and step logs. The user can only fetch their own.
 *
 * PATCH /api/applications/[id]
 *   Accepts { userRemark: string }. Saves a free-form user note onto
 *   the submission record. No other fields are user-editable here —
 *   everything else is worker-owned.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, submissionKey } from "@/lib/redis";
import { getSubmission, type SubmissionRecord } from "@/lib/submissions";

const SUBMISSION_TTL_SECONDS = 60 * 60 * 24 * 90;

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = ctx.params;
  const submission = await getSubmission(session.user.email, id);
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Defense-in-depth: the key is already scoped to the email, but verify
  // the record's userId matches the session as well.
  if (submission.userId !== session.user.email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ submission });
}

interface PatchBody {
  userRemark?: unknown;
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const { id } = ctx.params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // We only accept userRemark via this route. Any other field is silently
  // ignored — keeps the worker as the only writer of state-bearing fields.
  if (typeof body.userRemark !== "string") {
    return NextResponse.json(
      { error: "Body must be { userRemark: string }" },
      { status: 400 }
    );
  }
  // Cap length to prevent runaway notes from bloating the record.
  const remark = body.userRemark.slice(0, 1000);

  const existing = await redis.get<SubmissionRecord>(submissionKey(email, id));
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.userId !== email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const next: SubmissionRecord = { ...existing, userRemark: remark };
  await redis.set(submissionKey(email, id), next, { ex: SUBMISSION_TTL_SECONDS });
  return NextResponse.json({ submission: next });
}
