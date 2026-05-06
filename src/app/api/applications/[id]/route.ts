/**
 * GET /api/applications/[id]
 *   Returns the full submission record for one application, including
 *   screenshots and step logs. The user can only fetch their own.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSubmission } from "@/lib/submissions";

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
