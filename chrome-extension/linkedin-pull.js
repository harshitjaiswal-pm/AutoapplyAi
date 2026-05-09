/**
 * LINKEDIN AUTO-PULL — Content script triggered from /console.
 *
 * Flow:
 *   1. User on /console clicks "Pull from LinkedIn", fills filter form.
 *   2. /console postMessages the trigger config to pipeline-bridge.js (a
 *      content script that runs on the same page). pipeline-bridge.js
 *      writes chrome.storage.local._aa_pull_linkedin = {keywords, location,
 *      remote, count, consoleUrl}. Page-side JS can't write chrome.storage
 *      directly because content scripts run in an isolated world.
 *   3. /console opens linkedin.com/jobs/search?... in a new tab.
 *   4. THIS SCRIPT runs on the search page, reads the storage trigger,
 *      scrapes visible job cards, filters out Easy Apply, resolves each
 *      survivor's external ATS apply URL via fetch(), stuffs results into
 *      chrome.storage.local.pendingJobs, and navigates back to /console.
 *   5. /console runs pipeline-bridge.js which POSTs each pending job to
 *      /api/console/jobs. That endpoint validates, dedupes, and enforces
 *      the 100/day cap.
 *
 * Why a separate file (not bolted onto content.js): content.js has a 3000+
 * line floating-panel + Easy Apply autofill flow. This is a small auto
 * scraper that only fires when the trigger flag is set.
 */

(() => {
  // Only fire on LinkedIn job search pages — both the classic /jobs/search
  // and the AI-powered /jobs/search-results URLs.
  if (!/^\/jobs\/search/.test(location.pathname)) return;

  // Race tolerance: the page postMessages the config, the bridge writes
  // it to chrome.storage, then the new tab opens. Storage write is fast
  // but not instant; if the LinkedIn page loads before the storage
  // write completes, we'd bail. So we poll a few times before giving up.
  pollForTrigger(0);

  function pollForTrigger(attempt) {
    chrome.storage.local.get(["_aa_pull_linkedin"], (data) => {
      const cfg = data._aa_pull_linkedin;
      if (cfg) {
        // Clear it so a refresh / back-button doesn't re-fire.
        chrome.storage.local.remove(["_aa_pull_linkedin"], () => {
          // Wait for LinkedIn to render result cards (~2s after document_idle).
          setTimeout(() => start(cfg), 2000);
        });
        return;
      }
      // No trigger yet. Try a few more times — bridge's write may not
      // have landed when the new tab loaded. After 4 attempts (~3s) bail.
      if (attempt >= 4) return;
      setTimeout(() => pollForTrigger(attempt + 1), 600);
    });
  }

  function start(cfg) {
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

      // Try to resolve each job's external ATS URL. Modern LinkedIn doesn't
      // ship the apply URL in the SSR HTML for /jobs/view/<id> — it's
      // fetched lazily via voyager API at click-time. So our fetch-and-grep
      // succeeds rarely. When it fails, FALL BACK to the LinkedIn URL
      // itself: the user can still click into the captured row from /console,
      // LinkedIn redirects to the ATS, and the existing extension takes over.
      // Better than dropping the job entirely.
      showOverlay(`Resolving apply URLs for ${external.length} jobs…`);
      const resolved = [];
      let resolvedCount = 0;
      for (let i = 0; i < external.length; i++) {
        const j = external[i];
        showOverlay(`Resolving ${i + 1}/${external.length}: ${j.title}`);
        const applyUrl = await resolveApplyUrl(j.linkedinJobId);
        if (applyUrl) {
          resolvedCount++;
          resolved.push({
            jobUrl: applyUrl,
            title: j.title,
            company: j.company,
            location: j.location,
            source: "extension",
          });
        } else if (j.linkedinJobId) {
          // Fall back to the LinkedIn URL — capture is still useful as a
          // staging row even if we can't auto-apply.
          resolved.push({
            jobUrl: `https://www.linkedin.com/jobs/view/${j.linkedinJobId}/`,
            title: j.title,
            company: j.company,
            location: j.location,
            source: "extension",
          });
        }
        // Tiny stagger so we don't hammer LinkedIn with 25 fetches in
        // ~one event-loop tick. 200ms keeps the user's request rate
        // indistinguishable from a person clicking through results.
        await new Promise((r) => setTimeout(r, 200));
      }

      if (resolved.length === 0) {
        showOverlay(`No jobs to capture — ${skippedEasyApply} Easy Apply skipped.`, "error");
        return;
      }
      const linkedinFallbackCount = resolved.length - resolvedCount;

      chrome.storage.local.set({ pendingJobs: resolved }, () => {
        const parts = [`Captured ${resolved.length} jobs`];
        if (resolvedCount > 0) parts.push(`${resolvedCount} resolved to ATS`);
        if (linkedinFallbackCount > 0) parts.push(`${linkedinFallbackCount} via LinkedIn URL`);
        if (skippedEasyApply) parts.push(`${skippedEasyApply} Easy Apply skipped`);
        showOverlay(`${parts.join(", ")}. Returning to Console…`, "ok");
        // Hand off to the Console — pipeline-bridge.js will POST each
        // pending job to /api/console/jobs as the page loads.
        setTimeout(() => {
          location.href = cfg.consoleUrl || "/";
        }, 1500);
      });
    }
  }


  /** Fetch the LinkedIn JD page (uses the user's session cookies), parse
   *  the HTML, and pull out the external Apply URL.
   *
   *  Three extraction patterns, ordered most-specific → least:
   *    1. <code id="applyUrl">"https://..."</code> — LinkedIn includes
   *       this hidden code block on external listings as part of their
   *       SSR data; cleanest extraction.
   *    2. data-tracking-control-name="public_jobs_apply-link-onsite|offsite"
   *       on an anchor — fallback for layouts without the applyUrl block.
   *    3. Last-resort regex against known ATS hosts — narrow enough to
   *       not grab a company-website link by mistake.
   *
   *  Returns null if none yields a usable URL — caller treats that
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

      // Pattern 3: any href that looks like an external apply URL on a
      // known ATS host. Last-resort.
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

  /** Scrape visible job cards. Mirrors the proven scrapeStrategyA +
   *  parseCardText logic from content.js — that scraper has been
   *  field-tested over months and handles edge cases like the
   *  "with verification" suffix, noise lines (Promoted, Easy Apply,
   *  "X days ago"), and emoji prefixes on locations. We duplicate it
   *  here rather than sharing the file so this script stays self
   *  contained and the LinkedIn search-page entrypoint isn't coupled
   *  to content.js's IIFE state. */
  function scrapeCards() {
    const cards = document.querySelectorAll("li[data-occludable-job-id]");
    console.log(`[AutoApply LinkedIn pull] found ${cards.length} cards in DOM`);
    const out = [];
    let failures = 0;
    cards.forEach((card, idx) => {
      try {
        const jobId = card.getAttribute("data-occludable-job-id") || "";
        const titleLink =
          card.querySelector("a.job-card-container__link") ||
          card.querySelector('a[href*="/jobs/view/"]') ||
          card.querySelector("a");
        let title = "";
        if (titleLink) {
          // <strong> > class*=title > aria-label > textContent
          // aria-label last because LinkedIn appends " with verification"
          title =
            titleLink.querySelector("strong")?.textContent?.trim() ||
            titleLink.querySelector('[class*="title"]')?.textContent?.trim() ||
            titleLink.getAttribute("aria-label") ||
            titleLink.textContent?.trim() ||
            "";
        }
        title = title.replace(/\s+with verification$/i, "").replace(/\s*\(Verified job\)/gi, "").trim();
        if (!title || title.length < 3) {
          failures++;
          console.log(`[AutoApply LinkedIn pull] card ${idx}: no usable title (link=${!!titleLink})`);
          return;
        }

        const { company, location: locationStr, easyApply } = parseCardText(card.innerText, title);
        out.push({ linkedinJobId: jobId, title, company, location: locationStr, easyApply });
      } catch (e) {
        failures++;
        console.warn(`[AutoApply LinkedIn pull] card ${idx} parse failed:`, e);
      }
    });
    console.log(`[AutoApply LinkedIn pull] scraped ${out.length} of ${cards.length} cards (${failures} failed)`);
    return out;
  }

  /** Mirrors content.js's parseCardText — robust company/location/easyApply
   *  extraction from the card's innerText. Skips noise lines, handles
   *  "with verification" suffix, normalizes location emoji prefixes. */
  function parseCardText(text, title) {
    text = (text || "").trim();
    if (!text || text.length < 10) return { company: "", location: "", easyApply: false };

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const titleLower = title.toLowerCase();
    const noiseWords = [
      "easy apply", "promoted", "verified", "actively recruiting",
      "actively reviewing", "viewed", "applied", "new", "dismiss",
      "be an early applicant", "people also viewed",
    ];

    let company = "";
    let location = "";
    let foundTitle = false;
    let companySet = false;

    for (const line of lines) {
      const lineLower = line.toLowerCase().replace(/\(verified job\)/i, "").trim();
      if (!foundTitle && (lineLower === titleLower || lineLower.includes(titleLower) || titleLower.includes(lineLower))) {
        foundTitle = true;
        continue;
      }
      if (foundTitle && lineLower === titleLower) continue;
      if (noiseWords.some((n) => lineLower === n || lineLower.startsWith(n))) continue;
      if (line.length < 2) continue;
      if (/^\d+\s+(day|hour|minute|week|month)s?\s+ago$/i.test(line)) continue;
      if (/^just now$/i.test(line)) continue;

      if (!companySet) {
        company = line.replace(/\s*\(Verified job\)/i, "").trim();
        companySet = true;
        continue;
      }
      if (!location) {
        const cleanLoc = line.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}️‍]+\s*/u, "").trim();
        if (cleanLoc.toLowerCase() === company.toLowerCase()) continue;
        location = cleanLoc;
        break;
      }
    }

    if (!company && lines.length >= 2) company = lines[1]?.replace(/\s*\(Verified job\)/i, "") || "";
    if (!location && lines.length >= 3) location = lines[2] || "";
    const easyApply = text.toLowerCase().includes("easy apply");

    return { company, location, easyApply };
  }

  /** Scroll the results list in chunks to fully lazy-load all 25 cards.
   *  LinkedIn renders cards as you scroll past them — a single jump to
   *  scrollHeight only loads the cards near the visible area, leaving
   *  cards in the middle un-rendered with empty innerText. Scrolling
   *  in 6-8 increments forces every chunk into the viewport at least
   *  once so the full card content is present when we scrape. */
  async function autoScroll() {
    const list = document.querySelector(".jobs-search-results-list, .scaffold-layout__list");
    if (!list) return;
    const steps = 8;
    const totalHeight = list.scrollHeight;
    for (let i = 1; i <= steps; i++) {
      list.scrollTo({ top: (totalHeight * i) / steps, behavior: "auto" });
      await new Promise((r) => setTimeout(r, 350));
    }
    // Scroll back to the top so the first card is in view, then settle.
    list.scrollTo({ top: 0, behavior: "auto" });
    await new Promise((r) => setTimeout(r, 600));
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
