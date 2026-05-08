import { describe, it, expect } from "vitest";
import { canonicalizeUrl, detectAts } from "./console";

/**
 * canonicalizeUrl is the dedup key for ConsoleJobs. Two URL captures from
 * different sources (paste, extension, search) merge into one row when
 * their canonical form matches. If this function drifts, dedup breaks
 * and the Captured tab fills with phantom duplicates.
 */
describe("canonicalizeUrl", () => {
  it("strips trailing slash", () => {
    expect(canonicalizeUrl("https://td.wd3.myworkdayjobs.com/jobs/123/")).toBe(
      "https://td.wd3.myworkdayjobs.com/jobs/123"
    );
  });

  it("lowercases the host but preserves path case", () => {
    // Path case matters — Workday job slugs encode the title.
    const out = canonicalizeUrl(
      "https://TD.wd3.MYWORKDAYJOBS.com/External/Job/SeniorPM_R_999"
    );
    expect(out).toBe("https://td.wd3.myworkdayjobs.com/External/Job/SeniorPM_R_999");
  });

  it("drops UTM and tracking params", () => {
    const out = canonicalizeUrl(
      "https://td.wd3.myworkdayjobs.com/jobs/123?utm_source=linkedin&utm_campaign=may&gh_src=ref&fbclid=abc"
    );
    expect(out).toBe("https://td.wd3.myworkdayjobs.com/jobs/123");
  });

  it("preserves non-tracking params", () => {
    const out = canonicalizeUrl(
      "https://boards.greenhouse.io/co/jobs/123?gh_jid=internal&utm_source=linkedin"
    );
    expect(out).toContain("gh_jid=internal");
    expect(out).not.toContain("utm_source");
  });

  it("drops fragment", () => {
    expect(canonicalizeUrl("https://example.com/jobs/123#requirements")).toBe(
      "https://example.com/jobs/123"
    );
  });

  it("returns trimmed lowercase as fallback for non-URL input", () => {
    // We don't want to throw on bad input — the dedup key just degrades to
    // a case-insensitive string match for whatever was pasted.
    expect(canonicalizeUrl("  Not A URL  ")).toBe("not a url");
  });

  it("two URLs differing only by tracking params produce the same canonical", () => {
    const a = canonicalizeUrl("https://x.myworkdayjobs.com/jobs/1?utm_source=a");
    const b = canonicalizeUrl("https://x.myworkdayjobs.com/jobs/1?utm_source=b");
    expect(a).toBe(b);
  });

  it("two URLs with different paths are NOT collapsed (dedup-by-slug)", () => {
    // Same role, different slug typo → different jobs. The Console UI
    // surfaces these as possible duplicates rather than auto-merging.
    const a = canonicalizeUrl("https://x.myworkdayjobs.com/jobs/Senior-PM_R-1");
    const b = canonicalizeUrl("https://x.myworkdayjobs.com/jobs/Senior-Pm_R-1");
    expect(a).not.toBe(b);
  });
});

/**
 * detectAts drives icon + tenant-specific behavior in the Console UI.
 * Wrong classification = wrong-shaped wizard handler when the worker
 * runs the job. Critical the host pattern matching is correct.
 */
describe("detectAts", () => {
  it("recognizes Workday tenants via myworkdayjobs.com", () => {
    expect(detectAts("https://td.wd3.myworkdayjobs.com/jobs/123")).toBe("workday");
    expect(detectAts("https://intactfc.wd3.myworkdayjobs.com/External/job/X")).toBe(
      "workday"
    );
  });

  it("recognizes Greenhouse via greenhouse.io", () => {
    expect(detectAts("https://boards.greenhouse.io/company/jobs/123")).toBe(
      "greenhouse"
    );
  });

  it("recognizes Lever via lever.co", () => {
    expect(detectAts("https://jobs.lever.co/company/abc-123")).toBe("lever");
  });

  it("recognizes Ashby via ashbyhq.com", () => {
    expect(detectAts("https://jobs.ashbyhq.com/company/abc")).toBe("ashby");
  });

  it("returns 'other' for unknown hosts", () => {
    expect(detectAts("https://careers.example.com/jobs/123")).toBe("other");
  });

  it("returns 'other' for non-URL input rather than throwing", () => {
    expect(detectAts("not a url")).toBe("other");
  });

  it("is case-insensitive on host", () => {
    expect(detectAts("https://TD.WD3.MYWORKDAYJOBS.COM/jobs/123")).toBe("workday");
  });
});
