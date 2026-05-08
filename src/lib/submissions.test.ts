import { describe, it, expect } from "vitest";
import { deriveOutcome, type SubmissionRecord } from "./submissions";

/**
 * deriveOutcome is the source of truth the dashboard uses to decide between
 * "Submitted" (green), "Partial" (amber), "Failed" (red), "Running" (blue).
 *
 * Three paths through the function:
 *   1. status === "in_progress" → running
 *   2. status === "failed" → failed
 *   3. status === "completed" → look at applicationSubmitted; legacy
 *      records (no flag) fall back to confirmation-screenshot heuristic
 *
 * These cases are the contract — if any change here, dashboard renders
 * a wrong badge and the user trusts data they shouldn't.
 */
function makeSubmission(overrides: Partial<SubmissionRecord>): SubmissionRecord {
  return {
    applicationId: "test-id",
    userId: "test@example.com",
    jobUrl: "https://example.com",
    jobTitle: "Test",
    company: "Test Co",
    status: "completed",
    startedAt: "2026-05-08T00:00:00.000Z",
    screenshots: [],
    steps: [],
    source: "smoke",
    ...overrides,
  };
}

describe("deriveOutcome", () => {
  it("returns 'running' when status is in_progress, regardless of other fields", () => {
    expect(
      deriveOutcome(
        makeSubmission({ status: "in_progress", applicationSubmitted: true })
      )
    ).toBe("running");
    expect(
      deriveOutcome(
        makeSubmission({ status: "in_progress", applicationSubmitted: false })
      )
    ).toBe("running");
  });

  it("returns 'failed' when status is failed, regardless of applicationSubmitted", () => {
    expect(
      deriveOutcome(
        makeSubmission({ status: "failed", applicationSubmitted: false })
      )
    ).toBe("failed");
    // Belt-and-suspenders: even if a buggy worker wrote applicationSubmitted=true
    // alongside status=failed, status takes precedence — failed means failed.
    expect(
      deriveOutcome(
        makeSubmission({ status: "failed", applicationSubmitted: true })
      )
    ).toBe("failed");
  });

  it("returns 'submitted' when completed and applicationSubmitted=true", () => {
    expect(
      deriveOutcome(
        makeSubmission({ status: "completed", applicationSubmitted: true })
      )
    ).toBe("submitted");
  });

  it("returns 'partial' when completed but applicationSubmitted=false", () => {
    // Critical case: the worker exited cleanly (status=completed) but the
    // wizard didn't reach the confirmation page. Pre-PR-#31 these were
    // mislabeled as Submitted; the deriveOutcome contract is the
    // last-line-of-defense if a future regression sneaks through.
    expect(
      deriveOutcome(
        makeSubmission({ status: "completed", applicationSubmitted: false })
      )
    ).toBe("partial");
  });

  describe("legacy records (no applicationSubmitted flag)", () => {
    it("returns 'submitted' if a confirmation screenshot was captured", () => {
      expect(
        deriveOutcome(
          makeSubmission({
            status: "completed",
            applicationSubmitted: undefined,
            screenshots: [
              { step: "confirmation", url: "https://blob/c.png", capturedAt: "" },
            ],
          })
        )
      ).toBe("submitted");
    });

    it("returns 'partial' if no confirmation screenshot exists", () => {
      expect(
        deriveOutcome(
          makeSubmission({
            status: "completed",
            applicationSubmitted: undefined,
            screenshots: [
              { step: "step-1", url: "https://blob/s1.png", capturedAt: "" },
            ],
          })
        )
      ).toBe("partial");
    });

    it("returns 'partial' when screenshots is missing entirely", () => {
      // Cast to satisfy the type, then bash to undefined to exercise the
      // defensive `?? []` inside deriveOutcome. Some legacy records in
      // Upstash were written before screenshots was always-present.
      const rec = makeSubmission({
        status: "completed",
        applicationSubmitted: undefined,
      });
      (rec as { screenshots: unknown }).screenshots = undefined;
      expect(deriveOutcome(rec)).toBe("partial");
    });
  });
});
