import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateAndScrapeUrl } from "./jdValidator";

/**
 * Mocks `globalThis.fetch` so the tests don't actually hit Workday.
 * Each test sets up the shape of response it wants.
 */
const realFetch = globalThis.fetch;

function mockResponse(opts: {
  status?: number;
  body?: string;
}): Response {
  return new Response(opts.body ?? "", {
    status: opts.status ?? 200,
    headers: { "content-type": "text/html" },
  });
}

beforeEach(() => {
  // Reset any previous mock between tests
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("validateAndScrapeUrl", () => {
  it("returns alive=false when status is 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 404 }));
    const r = await validateAndScrapeUrl("https://td.wd3.myworkdayjobs.com/dead-job");
    expect(r.alive).toBe(false);
    if (!r.alive) {
      expect(r.reason).toMatch(/HTTP 404/);
    }
  });

  it("returns alive=false when body matches soft-404 pattern", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: "<html><body><h1>The page you are looking for doesn't exist</h1></body></html>",
      })
    );
    const r = await validateAndScrapeUrl("https://td.wd3.myworkdayjobs.com/maybe-dead");
    expect(r.alive).toBe(false);
    if (!r.alive) {
      expect(r.reason).toMatch(/not found/i);
    }
  });

  it("returns alive=false on requisition-closed body pattern", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ status: 200, body: "<p>This requisition is closed.</p>" })
    );
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r.alive).toBe(false);
  });

  it("returns alive=true with auth-required pages (401/403)", async () => {
    // 401/403 mean the page exists but we can't read it — not a dead listing.
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 401 }));
    const r401 = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r401.alive).toBe(true);

    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 403 }));
    const r403 = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r403.alive).toBe(true);
  });

  it("returns alive=true on network timeout (don't block on flaky checks)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    );
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r.alive).toBe(true);
  });

  it("returns alive=false on generic network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND no-such-tenant.com"));
    const r = await validateAndScrapeUrl("https://no-such-tenant.com/x");
    expect(r.alive).toBe(false);
    if (!r.alive) {
      expect(r.reason).toMatch(/Network error/);
    }
  });

  it("scrapes <title> + tenant company on alive page", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: "<html><head><title>Senior Product Manager - TD Bank Careers</title></head><body>real content</body></html>",
      })
    );
    const r = await validateAndScrapeUrl(
      "https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/job/Toronto-Ontario/Senior-Product-Manager_R_123456"
    );
    expect(r.alive).toBe(true);
    if (r.alive) {
      expect(r.title).toBe("Senior Product Manager");
      expect(r.company).toBe("Td");
    }
  });

  it("falls back to raw title when stripping would remove too much", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: "<html><head><title>SaaS Engineering Manager</title></head><body>...</body></html>",
      })
    );
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r.alive).toBe(true);
    if (r.alive) {
      expect(r.title).toBe("SaaS Engineering Manager");
    }
  });

  it("recognizes posting-expired pattern", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ status: 200, body: "<p>Sorry, this posting has expired.</p>" })
    );
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r.alive).toBe(false);
  });

  it("returns alive=true for non-Workday hosts (no company guess)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ status: 200, body: "<title>Some page</title>" })
    );
    const r = await validateAndScrapeUrl("https://example.com/jobs/123");
    expect(r.alive).toBe(true);
    if (r.alive) {
      expect(r.company).toBeUndefined();
    }
  });
});
