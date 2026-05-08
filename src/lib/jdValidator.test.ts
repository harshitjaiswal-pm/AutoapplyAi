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

  it("returns alive=true when body has soft-404 phrases on a 200 response (we DON'T body-match anymore)", async () => {
    // Body-text matching was removed 2026-05-09 — too false-positive-prone
    // on Workday SPAs that render dead-listing notices client-side AND
    // include those same phrases incidentally in legit page boilerplate.
    // Worker (smoke_full_apply.ts) is the source of truth for SPA-rendered
    // soft-404 detection.
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: "<html><body><h1>Senior PM</h1><p>This perk is no longer available</p></body></html>",
      })
    );
    const r = await validateAndScrapeUrl("https://thomsonreuters.wd5.myworkdayjobs.com/x");
    expect(r.alive).toBe(true);
  });

  it("returns alive=true on a 200 page with 'requisition closed' phrase (Workday SPA shell artifact)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ status: 200, body: "<p>This requisition is closed.</p>" })
    );
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    // We no longer body-match; would be a false positive on legit pages.
    expect(r.alive).toBe(true);
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

  it("does NOT body-match 'posting expired' on a 200 (false-positive prevention)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ status: 200, body: "<p>Sorry, this posting has expired.</p>" })
    );
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r.alive).toBe(true);
  });

  it("returns alive=false on HTTP 410 Gone", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 410 }));
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    expect(r.alive).toBe(false);
  });

  it("returns alive=true on HTTP 5xx (server error, not dead)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 503 }));
    const r = await validateAndScrapeUrl("https://x.myworkdayjobs.com/x");
    // 5xx is transient infrastructure trouble, not a dead listing.
    // Worker will hit the URL again on the actual run and decide.
    expect(r.alive).toBe(true);
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
