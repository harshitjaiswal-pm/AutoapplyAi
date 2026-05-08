import { redis, monthlyBudgetKey } from "./redis";

/**
 * Cost tracking + budget enforcement.
 *
 * Two ceilings:
 *   - PER_APP_BUDGET_CENTS = 5 ($0.05). One application's tailoring should
 *     never exceed this. Today (Haiku) typical is 0.5-2¢, so the cap is a
 *     safety net for catastrophic failure modes (wrong model, runaway
 *     loop). We log a warning when crossed but don't refuse the result —
 *     the cost was already incurred.
 *   - MONTHLY_BUDGET_CENTS = 1000 ($10/user/month). Pre-call check on
 *     every Anthropic-billable route. Refuse with HTTP 402 if the user
 *     is at/over their cap. The cap is per-user and per-calendar-month.
 *
 * Override: BUDGET_USER_OVERRIDES env var of the form
 *   "user1@example.com=2000,user2@example.com=5000"
 * lets a specific user bypass the default cap (cents). Useful for
 * batch-runs we authorize ahead of time without globally raising
 * everyone's limit.
 *
 * Cost source of truth: this module computes cents from Anthropic
 * `usage` (input_tokens, output_tokens) and the model name. Keeping
 * one place to do this means the worker's `tailoringCostCents` field
 * (computed independently in prepareTailoredResume.ts) and the monthly
 * counter never drift on definition — only on rounding, which is sub-cent.
 */

export const PER_APP_BUDGET_CENTS = 5;
export const DEFAULT_MONTHLY_BUDGET_CENTS = 1000;

interface ModelRate {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
}

/**
 * Anthropic public list prices as of 2026-05. Update when Anthropic
 * publishes new pricing.
 */
const MODEL_RATES: Record<string, ModelRate> = {
  // Haiku 4.5 — the default for /api/tailor-resume "fast" mode
  "claude-haiku-4-5": { in: 0.8, out: 4.0 },
  "claude-haiku-4-5-20251001": { in: 0.8, out: 4.0 },
  // Sonnet 4 — used for "pro" tailoring runs
  "claude-sonnet-4": { in: 3.0, out: 15.0 },
  "claude-sonnet-4-20250514": { in: 3.0, out: 15.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  // Opus 4 — currently unused by the app, included for completeness
  "claude-opus-4": { in: 15.0, out: 75.0 },
  "claude-opus-4-7": { in: 15.0, out: 75.0 },
};

/** Conservative fallback for unknown models — assumes Sonnet pricing so
 *  budget is more likely to refuse than over-provision. */
const FALLBACK_RATE: ModelRate = { in: 3.0, out: 15.0 };

/**
 * Compute cost in cents from Anthropic usage and model name.
 * Mirrors the math in autoapply-worker/steps/prepareTailoredResume.ts:296
 * so the per-app field and the monthly counter agree.
 */
export function costFromUsage(
  modelId: string,
  usage: { input_tokens?: number; output_tokens?: number } | undefined | null
): number {
  if (!usage) return 0;
  const rate = MODEL_RATES[modelId] ?? FALLBACK_RATE;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  // (USD per Mtok) → (USD per token) via /1_000_000, then to cents (×100).
  const usd = (inTok * rate.in + outTok * rate.out) / 1_000_000;
  // Round to two decimals (sub-cent precision); we store as a number on
  // SubmissionRecord but use Math.round for the integer counter below.
  return Math.round(usd * 100 * 100) / 100;
}

/**
 * Calendar-month bucket key. Same shape across timezones (UTC) so two
 * users in different zones don't see budget reset at different moments
 * relative to each other. "2026-05".
 */
export function monthKeyFor(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Resolve per-user monthly budget cap. Default applies unless the user's
 * email is in BUDGET_USER_OVERRIDES.
 */
export function getMonthlyBudgetCap(email: string): number {
  const raw = process.env.BUDGET_USER_OVERRIDES ?? "";
  if (!raw) return DEFAULT_MONTHLY_BUDGET_CENTS;
  const target = email.trim().toLowerCase();
  for (const entry of raw.split(",")) {
    const [user, capStr] = entry.split("=").map((s) => s.trim());
    if (!user || !capStr) continue;
    if (user.toLowerCase() === target) {
      const cap = parseInt(capStr, 10);
      if (Number.isFinite(cap) && cap >= 0) return cap;
    }
  }
  return DEFAULT_MONTHLY_BUDGET_CENTS;
}

/**
 * Read the current month-to-date spend in cents. Returns 0 if no key
 * exists yet (first call of the month).
 *
 * Storage is in hundredths-of-a-cent so a typical 0.7¢ Haiku call
 * doesn't round to either 0¢ or 1¢ on every increment. Read here
 * divides by 100 so callers always see cents.
 */
export async function getMonthlySpend(
  email: string,
  date: Date = new Date()
): Promise<number> {
  const key = monthlyBudgetKey(email, monthKeyFor(date));
  const raw = await redis.get<number | string>(key);
  if (raw == null) return 0;
  const hundredths = typeof raw === "number" ? raw : parseInt(raw, 10);
  if (!Number.isFinite(hundredths)) return 0;
  return Math.round((hundredths / 100) * 100) / 100;
}

export interface BudgetStatus {
  spendCents: number;
  capCents: number;
  remainingCents: number;
  isOver: boolean;
  monthKey: string;
}

/**
 * One-shot status fetch for the dashboard widget + pre-call gates.
 */
export async function getBudgetStatus(
  email: string,
  date: Date = new Date()
): Promise<BudgetStatus> {
  const monthKey = monthKeyFor(date);
  const spendCents = await getMonthlySpend(email, date);
  const capCents = getMonthlyBudgetCap(email);
  const remainingCents = Math.max(0, capCents - spendCents);
  return { spendCents, capCents, remainingCents, isOver: spendCents >= capCents, monthKey };
}

/**
 * Increment the monthly counter atomically. Best-effort: if Redis is
 * unreachable we log and continue rather than blocking the user's
 * application — the alternative (failing the tailor call because we
 * can't account for it) is worse than slightly inaccurate counting.
 *
 * 90-day TTL is set on the first write only — incrby on an existing
 * key keeps the existing TTL.
 */
export async function recordCost(
  email: string,
  cents: number,
  date: Date = new Date()
): Promise<void> {
  if (!email || cents <= 0) return;
  const key = monthlyBudgetKey(email, monthKeyFor(date));
  try {
    // INCRBY rounds cents to int. We store ¢×100 internally so sub-cent
    // costs (typical: 50-200 hundredths) accumulate without truncation.
    const hundredths = Math.round(cents * 100);
    await redis.incrby(key, hundredths);
    await redis.expire(key, 60 * 60 * 24 * 90);
  } catch (e) {
    console.warn(`[budget] failed to record cost for ${email}: ${(e as Error).message}`);
  }
}

/**
 * Check the per-app budget post-hoc. Logs a warning if exceeded but
 * doesn't refuse anything — the call already happened. Useful for
 * monitoring whether the $0.05 ceiling is being approached in practice.
 */
export function checkPerAppBudget(applicationId: string, cents: number): void {
  if (cents > PER_APP_BUDGET_CENTS) {
    console.warn(
      `[budget] application ${applicationId} cost ${cents.toFixed(2)}¢ — over PER_APP_BUDGET_CENTS=${PER_APP_BUDGET_CENTS}`
    );
  }
}

/**
 * Note on internal storage: we increment by `cents * 100` (hundredths of
 * a cent) so accumulation is integer-safe. To read in cents, divide by
 * 100. getMonthlySpend handles this so callers see cents consistently.
 */
