/**
 * GET /api/user/profile/completeness
 *
 * Returns a percentage score (0-100) for how complete the logged-in user's
 * profile is, plus a list of missing required fields. The /console page
 * uses this to decide whether to enable the "Queue" button — < 90% blocks
 * the user with a clear list of what to fill before they can apply.
 *
 * Rationale: incomplete profiles cause the autoapply-worker to bail mid-
 * Workday-wizard with cryptic errors like "step 1 did not advance, errors=2"
 * (which usually means a required field on the form was empty). The gate
 * fails fast at the source — before any LLM cost or worker time is spent.
 *
 * Weighting is hand-tuned: identity + address are heavily weighted because
 * Workday's My Information page always requires them; demographic fields
 * default to "Decline to Answer" so they don't penalize the score.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, userProfileKey, userResumeKey } from "@/lib/redis";
import type { StoredProfile } from "@/app/api/user/profile/route";

interface FieldCheck {
  label: string;
  weight: number;
  present: boolean;
  reason?: string;
}

export interface CompletenessReport {
  percent: number;
  meetsGate: boolean;
  earned: number;
  totalWeight: number;
  missing: Array<{ label: string; weight: number; reason?: string }>;
}

function isNonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Shared helper — used by this route's GET and by the enqueue endpoint
 * to gate worker dispatch. Keeping the scoring in one place means the
 * UI badge percentage and the server-side gate threshold can never drift.
 */
export async function computeProfileCompleteness(
  userId: string
): Promise<CompletenessReport> {
  let profile: StoredProfile | null = null;
  let hasResume = false;
  try {
    profile = await redis.get<StoredProfile>(userProfileKey(userId));
    const resume = await redis.get<unknown>(userResumeKey(userId));
    hasResume = !!resume;
  } catch (err) {
    console.error("completeness: redis read failed:", err);
    // Don't throw — treat as zero-completeness so the gate fails closed
    // (blocks queueing) rather than open. The caller can decide whether
    // to surface a 500 or fall back to a friendly error.
  }

  const checks: FieldCheck[] = [
    // Identity (25%) — every ATS asks for these
    { label: "First name", weight: 5, present: !!profile && isNonEmpty(profile.firstName) },
    { label: "Last name", weight: 5, present: !!profile && isNonEmpty(profile.lastName) },
    { label: "Email", weight: 5, present: !!profile && isNonEmpty(profile.email) },
    { label: "Phone number", weight: 10, present: !!profile && isNonEmpty(profile.phone) },
    // Address (25%) — Workday "My Information" step always requires
    { label: "Street address", weight: 5, present: !!profile && isNonEmpty(profile.address) },
    { label: "City", weight: 5, present: !!profile && isNonEmpty(profile.city) },
    { label: "Province / State", weight: 5, present: !!profile && isNonEmpty(profile.province) },
    { label: "Postal / ZIP code", weight: 10, present: !!profile && isNonEmpty(profile.postalCode) },
    // Career signals (10%)
    { label: "LinkedIn URL", weight: 5, present: !!profile && isNonEmpty(profile.linkedin) },
    { label: "Current company", weight: 5, present: !!profile && isNonEmpty(profile.currentCompany) },
    // Work authorization (10%) — single most-common bot-blocker
    {
      label: "Work authorization (require sponsorship: yes/no)",
      weight: 10,
      present: !!profile && isNonEmpty(profile.requireSponsorship),
    },
    // Resume on file (30%) — without this the worker can't tailor anything
    {
      label: "Master resume uploaded",
      weight: 30,
      present: hasResume,
      reason: hasResume ? undefined : "Upload your resume on the Tailor Resume page",
    },
  ];

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.filter((c) => c.present).reduce((s, c) => s + c.weight, 0);
  const percent = Math.round((earned / totalWeight) * 100);
  const missing = checks
    .filter((c) => !c.present)
    .map((c) => ({ label: c.label, weight: c.weight, reason: c.reason }));

  // 90% is the gate threshold. Anything less and we block queueing.
  // Why 90 not 100: optional fields (github, portfolio, pronouns, salary
  // expectation) are excluded from the weight table; 90 lets the user
  // skip 1-2 "nice to have" fields like LinkedIn URL without being
  // blocked, while still ensuring every form-critical field is filled.
  return { percent, meetsGate: percent >= 90, earned, totalWeight, missing };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as { id?: string }).id || session.user.email!;
  const report = await computeProfileCompleteness(userId);
  return NextResponse.json(report);
}
