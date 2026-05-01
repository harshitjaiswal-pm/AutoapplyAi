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

  // Use EMAIL as the canonical userId across the whole system (worker, audit,
  // chrome.storage._aa_userId, /api/pending-fill, etc. all key on email).
  // Falls back to the Google sub only if email is somehow missing.
  const email = session.user.email!;
  const sub = (session.user as { id?: string }).id;

  try {
    // Read email-keyed first (canonical). Fall back to legacy sub-keyed entry
    // for users who onboarded before this migration; if found, opportunistically
    // copy it over to the email key so subsequent reads are fast.
    let data = await redis.get<StoredResume>(userResumeKey(email));
    if (!data && sub) {
      const legacy = await redis.get<StoredResume>(userResumeKey(sub));
      if (legacy) {
        await redis.set(userResumeKey(email), legacy);
        data = legacy;
      }
    }
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

  // Email is the canonical userId across the whole system.
  const email = session.user.email!;

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

    // Store with no expiry — persists until user replaces it.
    // Single canonical key: user:{email}:resume.
    await redis.set(userResumeKey(email), payload);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to save resume to Redis:", err);
    return NextResponse.json({ error: "Failed to save resume" }, { status: 500 });
  }
}
