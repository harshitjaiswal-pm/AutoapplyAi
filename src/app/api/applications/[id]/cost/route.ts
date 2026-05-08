/**
 * GET /api/applications/[id]/cost
 *
 * Returns the per-application cost breakdown — every Anthropic-billable
 * call's stage/model/tokens/cents/timestamp, plus a totalCents and a
 * byStage rollup. Used by the application detail page's cost-breakdown
 * card.
 *
 * Auth: signed-in users can only see their own applications. Defense-
 * in-depth — the cost-events list itself is keyed only by applicationId
 * (not email), so we re-verify ownership via the SubmissionRecord.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSubmission } from "@/lib/submissions";
import { getCostBreakdown } from "@/lib/budget";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const { id } = ctx.params;

  // Verify ownership before exposing cost detail.
  const submission = await getSubmission(email, id);
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (submission.userId !== email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const breakdown = await getCostBreakdown(id);
  if (!breakdown) {
    // No events recorded yet for this app — could be a pre-cost-analytics
    // run, or just one that hasn't hit any LLM call. Return an empty
    // shape rather than 404 so the dashboard card can render
    // "no cost data" cleanly.
    return NextResponse.json({ events: [], totalCents: 0, byStage: {} });
  }
  return NextResponse.json(breakdown);
}
