/**
 * GET /api/budget
 *
 * Returns the signed-in user's current month-to-date spend, cap, and
 * remaining budget. Powers the dashboard widget. Auth required — no
 * anonymous reads.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getBudgetStatus } from "@/lib/budget";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const status = await getBudgetStatus(session.user.email);
  return NextResponse.json(status);
}
