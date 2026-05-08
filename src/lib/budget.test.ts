import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  costFromUsage,
  monthKeyFor,
  getMonthlyBudgetCap,
  PER_APP_BUDGET_CENTS,
  DEFAULT_MONTHLY_BUDGET_CENTS,
  type CostEvent,
} from "./budget";

/**
 * Pure-logic tests for the cost/budget module. Excludes Redis-touching
 * functions (recordCost, getMonthlySpend) — those are exercised by
 * autoapply-worker/scripts/verify_console.ts when we add a budget
 * sentinel run.
 */

describe("costFromUsage", () => {
  it("returns 0 when usage is missing", () => {
    expect(costFromUsage("claude-haiku-4-5", null)).toBe(0);
    expect(costFromUsage("claude-haiku-4-5", undefined)).toBe(0);
    expect(costFromUsage("claude-haiku-4-5", {})).toBe(0);
  });

  it("computes Haiku 4.5 cost from input + output tokens", () => {
    // Haiku rate: $0.80/Mtok in, $4.00/Mtok out
    // 5000 input + 5000 output:
    //   in:  5000 * 0.80 / 1_000_000 = $0.004
    //   out: 5000 * 4.00 / 1_000_000 = $0.020
    //   total: $0.024 = 2.4 cents
    const cost = costFromUsage("claude-haiku-4-5", {
      input_tokens: 5000,
      output_tokens: 5000,
    });
    expect(cost).toBeCloseTo(2.4, 2);
  });

  it("computes Sonnet 4 cost from input + output tokens", () => {
    // Sonnet rate: $3.00/Mtok in, $15.00/Mtok out
    // 1000 + 1000:
    //   in:  1000 * 3.00 / 1_000_000 = $0.003
    //   out: 1000 * 15.00 / 1_000_000 = $0.015
    //   total: $0.018 = 1.8 cents
    const cost = costFromUsage("claude-sonnet-4-20250514", {
      input_tokens: 1000,
      output_tokens: 1000,
    });
    expect(cost).toBeCloseTo(1.8, 2);
  });

  it("falls back to Sonnet pricing for unknown models (conservative)", () => {
    // Unknown model id should use the conservative fallback (Sonnet rate)
    // so the budget over-estimates rather than under-counts.
    const cost = costFromUsage("claude-future-model-2030", {
      input_tokens: 1000,
      output_tokens: 1000,
    });
    expect(cost).toBeCloseTo(1.8, 2); // Sonnet fallback
  });

  it("handles zero token counts gracefully", () => {
    expect(
      costFromUsage("claude-haiku-4-5", { input_tokens: 0, output_tokens: 0 })
    ).toBe(0);
  });

  it("handles only input tokens (no output yet)", () => {
    // 1000 input @ Haiku: $0.0008 = 0.08 cents
    const cost = costFromUsage("claude-haiku-4-5", {
      input_tokens: 1000,
      output_tokens: 0,
    });
    expect(cost).toBeCloseTo(0.08, 2);
  });

  it("a typical Haiku tailoring call (~5K in, 5K out) is well under PER_APP_BUDGET_CENTS", () => {
    // Sanity: real Haiku tailoring runs cost ~0.5-2¢. The $0.05 cap is
    // a safety net for catastrophic failure modes, not a normal-case
    // gate. If this test fails because typical cost crept above 5¢,
    // we have a regression in token usage that needs investigation
    // BEFORE we relax the cap.
    const cost = costFromUsage("claude-haiku-4-5", {
      input_tokens: 5000,
      output_tokens: 5000,
    });
    expect(cost).toBeLessThan(PER_APP_BUDGET_CENTS);
  });
});

describe("monthKeyFor", () => {
  it("formats as YYYY-MM in UTC", () => {
    const may2026 = new Date(Date.UTC(2026, 4, 15)); // month is 0-indexed; 4 = May
    expect(monthKeyFor(may2026)).toBe("2026-05");
  });

  it("zero-pads single-digit months", () => {
    const jan = new Date(Date.UTC(2026, 0, 1));
    expect(monthKeyFor(jan)).toBe("2026-01");
    const sep = new Date(Date.UTC(2026, 8, 1));
    expect(monthKeyFor(sep)).toBe("2026-09");
  });

  it("rolls over correctly at December → January", () => {
    const dec = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(monthKeyFor(dec)).toBe("2026-12");
    const jan = new Date(Date.UTC(2027, 0, 1, 0, 0, 1));
    expect(monthKeyFor(jan)).toBe("2027-01");
  });
});

describe("getMonthlyBudgetCap", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.BUDGET_USER_OVERRIDES;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BUDGET_USER_OVERRIDES;
    else process.env.BUDGET_USER_OVERRIDES = originalEnv;
  });

  it("returns the default cap when no override env is set", () => {
    delete process.env.BUDGET_USER_OVERRIDES;
    expect(getMonthlyBudgetCap("anyone@example.com")).toBe(
      DEFAULT_MONTHLY_BUDGET_CENTS
    );
  });

  it("returns the default cap when override env is empty string", () => {
    process.env.BUDGET_USER_OVERRIDES = "";
    expect(getMonthlyBudgetCap("anyone@example.com")).toBe(
      DEFAULT_MONTHLY_BUDGET_CENTS
    );
  });

  it("returns user-specific cap from override env", () => {
    process.env.BUDGET_USER_OVERRIDES = "harshit@example.com=5000";
    expect(getMonthlyBudgetCap("harshit@example.com")).toBe(5000);
  });

  it("matches override case-insensitively on email", () => {
    process.env.BUDGET_USER_OVERRIDES = "Harshit@Example.com=5000";
    expect(getMonthlyBudgetCap("harshit@example.com")).toBe(5000);
    expect(getMonthlyBudgetCap("HARSHIT@EXAMPLE.COM")).toBe(5000);
  });

  it("supports multiple users separated by commas", () => {
    process.env.BUDGET_USER_OVERRIDES =
      "alice@example.com=2000, bob@example.com=3000 ,charlie@example.com=8000";
    expect(getMonthlyBudgetCap("alice@example.com")).toBe(2000);
    expect(getMonthlyBudgetCap("bob@example.com")).toBe(3000);
    expect(getMonthlyBudgetCap("charlie@example.com")).toBe(8000);
    expect(getMonthlyBudgetCap("dave@example.com")).toBe(
      DEFAULT_MONTHLY_BUDGET_CENTS
    );
  });

  it("falls back to default when override value is malformed", () => {
    process.env.BUDGET_USER_OVERRIDES = "bad@example.com=NaN";
    expect(getMonthlyBudgetCap("bad@example.com")).toBe(
      DEFAULT_MONTHLY_BUDGET_CENTS
    );
  });

  it("rejects negative override values (defaults instead)", () => {
    process.env.BUDGET_USER_OVERRIDES = "neg@example.com=-100";
    expect(getMonthlyBudgetCap("neg@example.com")).toBe(
      DEFAULT_MONTHLY_BUDGET_CENTS
    );
  });

  it("accepts zero as a valid override (lockout user)", () => {
    process.env.BUDGET_USER_OVERRIDES = "blocked@example.com=0";
    expect(getMonthlyBudgetCap("blocked@example.com")).toBe(0);
  });
});

/**
 * byStage rollup is computed inline in getCostBreakdown; aggregating
 * here mirrors that logic so we can verify the math without hitting
 * Redis. If getCostBreakdown ever moves the aggregation to a separate
 * helper we should re-export and call it directly.
 */
function aggregateByStage(events: CostEvent[]): Record<string, number> {
  const byStage: Record<string, number> = {};
  for (const ev of events) {
    byStage[ev.stage] = (byStage[ev.stage] ?? 0) + ev.cents;
  }
  return byStage;
}

describe("CostEvent byStage aggregation", () => {
  it("sums cents per stage across multiple events", () => {
    const events: CostEvent[] = [
      { stage: "resume_tailor", model: "claude-haiku-4-5", inputTokens: 5000, outputTokens: 5000, cents: 2.4, ts: "2026-05-08T01:00:00Z" },
      { stage: "answer_question", model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 100, cents: 0.05, ts: "2026-05-08T01:01:00Z" },
      { stage: "answer_question", model: "claude-haiku-4-5", inputTokens: 600, outputTokens: 120, cents: 0.06, ts: "2026-05-08T01:02:00Z" },
      { stage: "answer_question", model: "claude-haiku-4-5", inputTokens: 550, outputTokens: 110, cents: 0.05, ts: "2026-05-08T01:03:00Z" },
      { stage: "analyze_job", model: "claude-haiku-4-5", inputTokens: 1500, outputTokens: 800, cents: 0.32, ts: "2026-05-08T01:04:00Z" },
    ];
    const byStage = aggregateByStage(events);
    expect(byStage.resume_tailor).toBeCloseTo(2.4, 2);
    expect(byStage.answer_question).toBeCloseTo(0.16, 2);
    expect(byStage.analyze_job).toBeCloseTo(0.32, 2);
  });

  it("returns empty object for empty event list", () => {
    expect(aggregateByStage([])).toEqual({});
  });

  it("treats a single event as that stage's full spend", () => {
    const events: CostEvent[] = [
      { stage: "parse_resume", model: "claude-haiku-4-5", inputTokens: 2000, outputTokens: 1000, cents: 0.4, ts: "2026-05-08T00:00:00Z" },
    ];
    const byStage = aggregateByStage(events);
    expect(byStage.parse_resume).toBeCloseTo(0.4, 2);
    expect(Object.keys(byStage)).toHaveLength(1);
  });
});
