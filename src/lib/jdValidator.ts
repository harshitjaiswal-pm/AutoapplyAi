/**
 * Server-side capture-time validator for job-posting URLs.
 *
 * Two jobs:
 *   1. Detect dead listings BEFORE they enter the queue, so the user
 *      gets immediate feedback ("this listing appears to be expired")
 *      instead of finding out 2 minutes later when the dispatcher's
 *      worker bails on it. Eliminates the 24% `job_posting_dead`
 *      failure category at the source.
 *   2. Scrape title + company from the JD page when it IS alive, so
 *      pasted-URL captures don't show "—" placeholders for those
 *      fields. Defaults the user can override or accept.
 *
 * Soft-404 detection mirrors `autoapply-worker/scripts/smoke_full_apply.ts`'s
 * `isDeadListing()` so behavior is consistent: if the worker would bail
 * on the URL, we reject at capture instead.
 */

const SOFT_NOT_FOUND_RE =
  /the page you are looking for doesn['']?t exist|page not found|no longer available|requisition (?:is )?closed|posting (?:has )?expired/i;

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1_000_000; // 1MB — typical Workday JD is 50-300KB; cap protects us from runaway downloads

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
  if (res.status >= 400 && res.status !== 401 && res.status !== 403) {
    return { alive: false, reason: `Listing returned HTTP ${res.status}. Likely expired or pulled — find a fresh URL.` };
  }

  // Read up to MAX_BODY_BYTES. Workday JDs render in JS, so the
  // initial HTML is often a small SPA bootstrap; the soft-404 patterns
  // we care about are usually in the static SSR-ed body or meta tags.
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

  if (SOFT_NOT_FOUND_RE.test(body)) {
    return {
      alive: false,
      reason: 'Page rendered "not found" content despite 200 status. Listing was pulled or expired — find a fresh URL.',
    };
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
