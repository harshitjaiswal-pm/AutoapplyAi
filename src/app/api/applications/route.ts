/**
 * GET /api/applications
 *
 * Lists the current user's submissions written by autoapply-worker (the
 * Playwright bot that runs locally on Harshit's and Kiran's laptops).
 *
 * Schema: submissions:{email}:{applicationId} — written by worker's
 * submissions.ts. The corresponding index set submissions:index:{email}
 * lets us list them without SCAN.
 *
 * Empty list when the user hasn't run any submissions yet (or hasn't
 * connected a worker yet, since records only exist after the worker writes).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listSubmissions } from "@/lib/submissions";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const submissions = await listSubmissions(session.user.email);
    return NextResponse.json({ submissions });
  } catch (err) {
    console.error("Failed to list submissions:", err);
    return NextResponse.json({ error: "Failed to load submissions" }, { status: 500 });
  }
}
