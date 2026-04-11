import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, userResumeKey } from "@/lib/redis";

export interface StoredResume {
  resumeText: string;
  parsedResume: Record<string, unknown>;
  parsedResumeSummary: { name: string; jobCount: number; skillCount: number };
  savedAt: string;
}

/**
 * GET /api/user/resume
 * Returns the stored resume for the logged-in user.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id?: string }).id || session.user.email!;

  try {
    const data = await redis.get<StoredResume>(userResumeKey(userId));
    if (!data) return NextResponse.json({ resume: null });
    return NextResponse.json({ resume: data });
  } catch (err) {
    console.error("Failed to fetch resume from Redis:", err);
    return NextResponse.json({ error: "Failed to load resume" }, { status: 500 });
  }
}

/**
 * POST /api/user/resume
 * Saves the resume for the logged-in user.
 * Body: { resumeText, parsedResume, parsedResumeSummary }
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id?: string }).id || session.user.email!;

  try {
    const body = await request.json() as Omit<StoredResume, "savedAt">;
    const { resumeText, parsedResume, parsedResumeSummary } = body;

    if (!resumeText || !parsedResume || !parsedResumeSummary) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const payload: StoredResume = {
      resumeText,
      parsedResume,
      parsedResumeSummary,
      savedAt: new Date().toISOString(),
    };

    // Store with no expiry — persists until user replaces it
    await redis.set(userResumeKey(userId), payload);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to save resume to Redis:", err);
    return NextResponse.json({ error: "Failed to save resume" }, { status: 500 });
  }
}
