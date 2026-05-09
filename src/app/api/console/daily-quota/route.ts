/**
 * GET /api/console/daily-quota
 *
 * Returns this user's remaining capture quota for the current UTC day.
 * Used by the Console UI to show "X of 100 left today" next to the
 * Pull-from-LinkedIn button without having to hit the create endpoint.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";

const DAILY_CAPTURE_CAP = 100;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const today = new Date().toISOString().slice(0, 10);
  const key = `console:daily_capture:${email}:${today}`;
  const used = (await redis.get<number>(key)) ?? 0;
  return NextResponse.json({
    capCount: DAILY_CAPTURE_CAP,
    used,
    remaining: Math.max(0, DAILY_CAPTURE_CAP - used),
    resetsAt: `${today}T24:00:00Z`,
  });
}
