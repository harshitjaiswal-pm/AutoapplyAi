/**
 * LINKEDIN AUTO-PULL — Content script triggered from /console.
 *
 * Flow:
 *   1. User on /console clicks "Pull from LinkedIn", fills filter form.
 *   2. Console encodes {keywords, location, remote, count, consoleUrl} as
 *      base64 JSON and appends it to the LinkedIn URL hash:
 *        https://www.linkedin.com/jobs/search/?...#aa_pull=<base64>
 *      (Hash is used because page JS can't write chrome.storage from an
 *      isolated content-script world. URL hash is the simplest neutral
 *      channel between the two contexts.)
 *   3. THIS SCRIPT runs on the search page, decodes the hash, scrapes
 *      visible job cards, filters out Easy Apply, resolves each survivor's
 *      external ATS apply URL via fetch(), stuffs results into
 *      chrome.storage.local.pendingJobs, and navigates back to /console.
 *   4. /console runs pipeline-bridge.js which POSTs each pending job to
 *      /api/console/jobs. That endpoint validates, dedupes, and enforces
 *      the 100/day cap.
 *
 * Why a separate file (not bolted onto content.js): content.js has a 3000+
 * line floating-panel + Easy Apply autofill flow. This is a small auto
 * scraper that only fires when the URL hash carries the trigger token.
 */

(() => {
  // Only fire on LinkedIn job search pages — both the classic /jobs/search
  // and the AI-powered /jobs/search-results URLs.
  if (!/^\/jobs\/search/.test(location.pathname)) return;

  // Look for the trigger token in the URL hash. Bail silently if it's
  // missing so a normal LinkedIn search session is unaffected.
  const cfg = parsePullConfig(location.hash);
  if (!cfg) return;

  // Strip the trigger from the URL so a back-button or refresh doesn't
  // re-fire the scrape (and so it doesn't show up in the user's history).
  history.replaceState(null, "", location.pathname + location.search);

  // Run AFTER document_idle to give LinkedIn time to render the lazy-loaded
  // result cards. Two seconds covers the SSR + first hydration window.
  setTimeout(start, 2000);

  function start() {
    console.log("[AutoApply LinkedIn pull] trigger detected, scraping…", cfg);
    showOverlay("Scanning LinkedIn for jobs…");

    // Two passes: scroll once to lazy-load more cards, then scrape.
    autoScroll().then(scrapeAndForward).catch((e) => {
      console.error("[AutoApply LinkedIn pull] scrape failed:", e);
      showOverlay(`Scrape failed: ${e.message || e}`, "error");
    });

    async function scrapeAndForward() {
      const jobs = scrapeCards();
      if (!jobs.length) {
        showOverlay("No jobs found on this page. Try a different filter.", "error");
        return;
      }
      const targetCount = Math.min(jobs.length, cfg.count || 25);
      // Skip Easy Apply (worker can't drive LinkedIn's internal flow).
      // Take the top N external listings; if there aren't enough, take
      // what we've got rather than failing the whole pull.
      const external = jobs.filter((j) => !j.easyApply).slice(0, targetCount);
      const skippedEasyApply = jobs.length - jobs.filter((j) => !j.easyApply).length;

      // Resolve the actual ATS apply URL for each captured job. We're
      // already on linkedin.com in the user's authenticated browser, so
      // fetch('/jobs/view/<id>') uses their cookies and returns the full
      // JD HTML. We pull the external Apply URL out of the HTML and use
      // THAT as the worker's target — without it the worker would just
      // hit LinkedIn (which 401s server-side) and fail every job.
      showOverlay(`Resolving apply URLs for ${external.length} jobs…`);
      const resolved = [];
      for (let i = 0; i < external.length; i++) {
        const j = external[i];
        showOverlay(`Resolving apply URL ${i + 1}/${external.length}: ${j.title}`);
        const applyUrl = await resolveApplyUrl(j.linkedinJobId);
        // If we couldn't find an external apply URL, skip the job — keeping
        // it would just make the worker fail on LinkedIn-side auth.
        if (applyUrl) {
          resolved.push({
            jobUrl: applyUrl,
            title: j.title,
            company: j.company,
            location: j.location,
            source: "extension",
          });
        } else {
          console.log(`[AutoApply LinkedIn pull] no external apply URL for "${j.title}" — skipping`);
        }
        // Tiny stagger so we don't hammer LinkedIn with 25 fetches in
        // ~one event-loop tick. 200ms keeps the user's request rate
        // indistinguishable from a person clicking through results.
        await new Promise((r) => setTimeout(r, 200));
      }

      const skippedNoUrl = external.length - resolved.length;
      if (resolved.length === 0) {
        showOverlay(
          `Couldn't resolve any apply URLs. ${skippedEasyApply} Easy Apply, ${skippedNoUrl} unresolved.`,
          "error"
        );
        return;
      }

      chrome.storage.local.set({ pendingJobs: resolved }, () => {
        const parts = [`Captured ${resolved.length} jobs`];
        if (skippedEasyApply) parts.push(`skipped ${skippedEasyApply} Easy Apply`);
        if (skippedNoUrl) parts.push(`${skippedNoUrl} no external URL`);
        showOverlay(`${parts.join(", ")}. Returning to Console…`, "ok");
        // Hand off to the Console — pipeline-bridge.js will POST each
        // pending job to /api/console/jobs as the page loads.
        setTimeout(() => {
          location.href = cfg.consoleUrl || "/";
        }, 1500);
      });
    }
  }

  /** Decode the base64 JSON config from the URL hash. Returns null if
   *  the hash is missing the trigger token or fails to decode — caller
   *  treats null as "this is a normal LinkedIn search, do nothing". */
  function parsePullConfig(hash) {
    const m = (hash || "").match(/aa_pull=([A-Za-z0-9+/=]+)/);
    if (!m) return null;
    try {
      return JSON.parse(atob(m[1]));
    } catch (e) {
      console.warn("[AutoApply LinkedIn pull] failed to decode trigger:", e);
      return null;
    }
  }

  /** Fetch the LinkedIn JD page (uses the user's session cookies), parse
   *  the HTML, and pull out the external Apply URL.
   *
   *  Two patterns we look for, ordered most → least specific:
   *    1. <code id="applyUrl">"https://..."</code> — LinkedIn includes
   *       this hidden code block on external listings as part of their
   *       SSR data; cleanest extraction.
   *    2. data-tracking-control-name="public_jobs_apply-link-onsite|offsite"
   *       on an anchor — fallback for layouts that don't carry the
   *       applyUrl code block.
   *
   *  Returns null if neither yields a usable URL — caller treats that
   *  as "skip this job, can't apply automatically". */
  async function resolveApplyUrl(linkedinJobId) {
    if (!linkedinJobId) return null;
    try {
      const res = await fetch(`https://www.linkedin.com/jobs/view/${linkedinJobId}/`, {
        credentials: "include",
        headers: { Accept: "text/html" },
      });
      if (!res.ok) {
        console.warn(`[AutoApply LinkedIn pull] fetch /jobs/view/${linkedinJobId} → ${res.status}`);
        return null;
      }
      const html = await res.text();

      // Pattern 1: <code id="applyUrl">"https://..."</code>
      const codeMatch = html.match(/<code[^>]*id=["']applyUrl["'][^>]*>\s*"([^"]+)"\s*<\/code>/);
      if (codeMatch) {
        return decodeHtmlEntities(codeMatch[1]);
      }

      // Pattern 2: anchor with data-tracking-control-name
      const anchorMatch = html.match(
        /<a[^>]*data-tracking-control-name=["']public_jobs_apply-link-(?:onsite|offsite)["'][^>]*\shref=["']([^"']+)["']/
      );
      if (anchorMatch) {
        return decodeHtmlEntities(anchorMatch[1]);
      }

      // Pattern 3: any href that looks like an external apply URL.
      // Last-resort — narrow to known ATS hosts so we don't grab a
      // company-website link by mistake.
      const ats = html.match(
        /href=["'](https?:\/\/[^"']*(?:myworkdayjobs\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|icims\.com|successfactors\.com|brainhunter\.com|taleo\.net)[^"']*)["']/
      );
      if (ats) return decodeHtmlEntities(ats[1]);

      return null;
    } catch (e) {
      console.warn(`[AutoApply LinkedIn pull] resolve failed for ${linkedinJobId}:`, e);
      return null;
    }
  }

  function decodeHtmlEntities(s) {
    return s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/g, "/")
      .replace(/&#39;/g, "'");
  }

  /** Scrape visible job cards. Mirrors content.js's Strategy A — but kept
   *  intentionally simple and self-contained so we don't share state. */
  function scrapeCards() {
    const cards = document.querySelectorAll("li[data-occludable-job-id]");
    const out = [];
    cards.forEach((card) => {
      try {
        const jobId = card.getAttribute("data-occludable-job-id") || "";
        const titleLink =
          card.querySelector("a.job-card-container__link") ||
          card.querySelector('a[href*="/jobs/view/"]') ||
          card.querySelector("a");
        if (!titleLink) return;
        let title =
          titleLink.querySelector("strong")?.textContent?.trim() ||
          titleLink.querySelector('[class*="title"]')?.textContent?.trim() ||
          titleLink.getAttribute("aria-label") ||
          titleLink.textContent?.trim() ||
          "";
        title = title.replace(/\s+with verification$/i, "").replace(/\s*\(Verified job\)/gi, "").trim();
        if (!title || title.length < 3) return;

        const text = card.innerText || "";
        const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
        // First line is usually the title (skip it); next non-empty is company,
        // then location. LinkedIn varies — fall back to "" rather than picking junk.
        const titleIdx = lines.findIndex((l) => l.toLowerCase() === title.toLowerCase());
        const company = (lines[titleIdx + 1] || "").slice(0, 80);
        const locationStr = (lines[titleIdx + 2] || "").slice(0, 120);
        const easyApply = /easy apply/i.test(text);

        out.push({ linkedinJobId: jobId, title, company, location: locationStr, easyApply });
      } catch (e) {
        console.warn("[AutoApply LinkedIn pull] card parse failed:", e);
      }
    });
    return out;
  }

  /** Scroll down once to trigger LinkedIn's lazy-load, then back up. */
  function autoScroll() {
    return new Promise((resolve) => {
      const list = document.querySelector(".jobs-search-results-list, .scaffold-layout__list");
      if (!list) { resolve(); return; }
      list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
      setTimeout(() => {
        list.scrollTo({ top: 0, behavior: "auto" });
        setTimeout(resolve, 600);
      }, 800);
    });
  }

  /** Top-banner status overlay so the user sees what's happening on
   *  the LinkedIn tab before it auto-redirects. Three states: info /
   *  ok / error. Disappears with the redirect. */
  function showOverlay(message, level = "info") {
    let el = document.getElementById("aa-linkedin-pull-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "aa-linkedin-pull-overlay";
      el.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
        padding: 14px 24px; font: 600 14px -apple-system,system-ui,sans-serif;
        text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      `;
      document.body.appendChild(el);
    }
    const colors = {
      info: ["#1f2937", "#ffffff"],
      ok: ["#065f46", "#d1fae5"],
      error: ["#991b1b", "#fee2e2"],
    };
    const [bg, fg] = colors[level] || colors.info;
    el.style.background = bg;
    el.style.color = fg;
    el.textContent = `AutoApply: ${message}`;
  }
})();
