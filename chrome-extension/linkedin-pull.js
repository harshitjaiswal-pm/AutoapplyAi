/**
 * LINKEDIN AUTO-PULL — Content script triggered from /console.
 *
 * Flow:
 *   1. User on /console clicks "Pull from LinkedIn", fills filter form.
 *   2. Console writes chrome.storage.local._aa_pull_linkedin = {keywords, location, remote, count, consoleUrl}
 *   3. Console opens linkedin.com/jobs/search?keywords=…&location=…&f_WT=2 in a new tab.
 *   4. THIS SCRIPT runs on the search page, sees the trigger flag, scrapes
 *      visible job cards, filters out Easy Apply, stuffs the survivors into
 *      chrome.storage.local.pendingJobs, and navigates the tab back to /console.
 *   5. /console runs `pipeline-bridge.js` which POSTs each pending job to
 *      /api/console/jobs. That endpoint validates, dedupes, and enforces the
 *      100/day cap.
 *
 * Why a separate file (not bolted onto content.js): content.js has a 3000+
 * line floating-panel + Easy Apply autofill flow. This is a 100-line auto
 * scraper that only fires when the trigger flag is set. Keeping them apart
 * means the main content.js path is unaffected.
 */

(() => {
  // Only fire on LinkedIn job search pages — both the classic /jobs/search
  // and the AI-powered /jobs/search-results URLs.
  if (!/^\/jobs\/search/.test(location.pathname)) return;

  // Run AFTER document_idle to give LinkedIn time to render the lazy-loaded
  // result cards. Two seconds covers the SSR + first hydration window.
  setTimeout(start, 2000);

  function start() {
    chrome.storage.local.get(["_aa_pull_linkedin"], (data) => {
      const cfg = data._aa_pull_linkedin;
      if (!cfg) return; // No active pull request — bail silently.

      console.log("[AutoApply LinkedIn pull] trigger detected, scraping…", cfg);
      showOverlay("Scanning LinkedIn for jobs…");

      // Two passes: scroll once to lazy-load more cards, then scrape.
      autoScroll().then(scrapeAndForward).catch((e) => {
        console.error("[AutoApply LinkedIn pull] scrape failed:", e);
        showOverlay(`Scrape failed: ${e.message || e}`, "error");
      });

      function scrapeAndForward() {
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

        const pending = external.map((j) => ({
          jobUrl: j.linkedinJobId
            ? `https://www.linkedin.com/jobs/view/${j.linkedinJobId}/`
            : location.href,
          title: j.title,
          company: j.company,
          location: j.location,
        }));

        chrome.storage.local.set({ pendingJobs: pending }, () => {
          // Clear the trigger so a refresh of this tab doesn't re-fire.
          chrome.storage.local.remove(["_aa_pull_linkedin"], () => {
            showOverlay(
              `Captured ${pending.length} jobs (skipped ${skippedEasyApply} Easy Apply). Returning to Console…`,
              "ok"
            );
            // Hand off to the Console — pipeline-bridge.js will POST each
            // pending job to /api/console/jobs as the page loads.
            setTimeout(() => {
              location.href = cfg.consoleUrl || "/";
            }, 1500);
          });
        });
      }
    });
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
