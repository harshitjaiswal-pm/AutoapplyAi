/**
 * Server-side capture-time validator for job-posting URLs.
 *
 * Two jobs:
 *   1. Reject HARD-dead listings (HTTP 4xx) before they enter the queue.
 *   2. Scrape title + company from the JD page when alive, so paste-flow
 *      rows don't show "—" placeholders for those fields.
 *
 * What we DO NOT do anymore (removed 2026-05-09 morning):
 *   - Body-text soft-404 detection. Workday tenants are SPAs that hydrate
 *     dead-listing notices client-side AFTER the server returns 200, so
 *     this validator never sees the "Posting not found" text. Worse: the
 *     same generic phrases ("no longer available", "page not found")
 *     appear incidentally in legit pages — footer accessibility notices,
 *     tenant boilerplate, search-no-results messages — causing real
 *     listings to be falsely rejected (Thomson Reuters wd5 case caught
 *     2026-05-09). The worker (smoke_full_apply.ts) still does the
 *     full Playwright-rendered soft-404 check on every actual run; that
 *     remains the source of truth for SPA-rendered dead listings.
 */

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 200_000; // 200KB — only scraping <title>; don't need the whole page

export type ValidationResult =
  | { alive: false; reason: string }
  | { alive: true; title?: string; company?: string; location?: string };

/**
 * Fetch the URL with a hard timeout. Reject if status >= 400 (excluding
 * 401/403, which mean the page exists but requires auth — those don't
 * indicate a dead listing). Otherwise read body and check for soft-404
 * patterns. If alive, extract `<title>` and best-guess company.
 */
export async function validateAndScrapeUrl(url: string): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      // Workday tenants serve different content to non-browser UAs and
      // sometimes 403 generic clients. Use a reasonable browser UA so we
      // get the same HTML the worker will see.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    const msg = (e as Error).message || String(e);
    if (/abort/i.test(msg)) {
      // Timeout = inconclusive (could be the user's network, or a slow
      // tenant). Allow the capture rather than blocking on a flaky
      // health check. Worker will catch it later if it's really dead.
      return { alive: true };
    }
    return { alive: false, reason: `Network error fetching URL: ${msg.slice(0, 200)}` };
  } finally {
    clearTimeout(timeout);
  }

  // Hard 4xx/5xx (excluding auth-required) → definitively dead.
  // 401/403 mean "page exists, requires auth" — different signal, not
  // a dead listing. 5xx is treated as transient (alive but degraded);
  // worker will pick it up later and decide.
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
    return { alive: false, reason: `Listing returned HTTP ${res.status}. Likely expired or pulled — find a fresh URL.` };
  }

  // Read up to MAX_BODY_BYTES — only need the <head> for <title> scrape.
  let body = "";
  try {
    const reader = res.body?.getReader();
    if (reader) {
      let bytes = 0;
      const decoder = new TextDecoder("utf-8");
      while (bytes < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        bytes += value.byteLength;
        body += decoder.decode(value, { stream: true });
      }
      try { reader.releaseLock(); } catch { /* tolerate */ }
    } else {
      body = await res.text();
    }
  } catch {
    // Couldn't read body — treat as alive (we got a 2xx/3xx status).
    return { alive: true };
  }

  // Alive. Best-effort scrape of the page <title> and a company guess
  // from the URL's tenant subdomain (Workday convention).
  const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
  const rawTitle = titleMatch?.[1]?.trim();
  // Workday <title> is often "Job Title - Tenant Careers" or
  // "Tenant Careers" alone (when Workday's SPA hasn't yet hydrated).
  // We strip the tenant suffix if it's there. Fall back to undefined
  // (caller renders "—") if nothing useful comes out.
  let cleanTitle: string | undefined;
  if (rawTitle && rawTitle.length > 0 && rawTitle.length < 300) {
    // "Senior Product Manager - TD Bank Careers" → "Senior Product Manager"
    cleanTitle = rawTitle.replace(/\s*[-|–·•]\s*[A-Z][A-Za-z0-9& ]+\s+(?:Careers|Jobs|Hiring)\s*$/i, "").trim();
    // Strip trailing tenant alone too: "Senior PM | TD"
    cleanTitle = cleanTitle.replace(/\s*[-|–·•]\s*[A-Za-z0-9& ]{2,40}\s*$/i, (m) => {
      // Don't strip if it removes more than half the title
      return m.length > cleanTitle!.length / 2 ? m : "";
    }).trim();
    if (!cleanTitle || cleanTitle.length < 4) cleanTitle = rawTitle;
  }

  // Company: prefer Workday subdomain (e.g. "td.wd3.myworkdayjobs.com" → "td"),
  // since the page <title> is unreliable. Capitalize.
  let company: string | undefined;
  try {
    const host = new URL(url).hostname;
    if (host.includes(".myworkdayjobs.com")) {
      const sub = host.split(".")[0];
      if (sub && sub.length < 40) company = sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase();
    }
  } catch { /* tolerate */ }

  return { alive: true, title: cleanTitle, company };
}
