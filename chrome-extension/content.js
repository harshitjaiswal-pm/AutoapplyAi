/**
 * CONTENT SCRIPT — Runs on LinkedIn job search pages.
 *
 * NEW FLOW (Auto-Apply):
 * 1. User clicks "Scan Page" to find jobs
 * 2. User selects jobs and clicks "Start Applying"
 * 3. For each job: click card → scrape JD from detail panel → click Apply →
 *    LinkedIn opens external site → background.js orchestrates tailoring →
 *    ATS content script fills the form
 *
 * The extension focuses on EXTERNAL apply (not Easy Apply).
 * LinkedIn uses obfuscated class names, so we use aria-labels and innerText.
 */

(() => {
  const SCRIPT_VERSION = "2.4.0";

  // Version-aware injection guard: always re-inject when version changes
  if (window.__autoapply_injected === SCRIPT_VERSION) return;
  window.__autoapply_injected = SCRIPT_VERSION;
  console.log(`AutoApply: Content script v${SCRIPT_VERSION} injecting...`);

  // State
  let scrapedJobs = [];
  let selectedJobIds = new Set();
  let isApplying = false;
  let currentJobIndex = 0;
  let appliedCount = 0;
  let skippedCount = 0;
  let skipRequested = false; // Set true to abort current job and advance to next

  /** Persist scrapedJobs & selectedJobIds to chrome.storage so they survive re-renders */
  function persistState() {
    chrome.storage.local.set({
      _aa_scrapedJobs: scrapedJobs,
      _aa_selectedIds: [...selectedJobIds],
    });
  }

  /** Restore state from chrome.storage on init */
  function restoreState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["_aa_scrapedJobs", "_aa_selectedIds"], (result) => {
        if (result._aa_scrapedJobs && Array.isArray(result._aa_scrapedJobs) && result._aa_scrapedJobs.length > 0) {
          scrapedJobs = result._aa_scrapedJobs;
          selectedJobIds = new Set(result._aa_selectedIds || []);
          console.log(`AutoApply: Restored ${scrapedJobs.length} jobs from storage`);
        }
        resolve();
      });
    });
  }

  /* ─────────────────────── SCRAPING ─────────────────────── */

  /**
   * Scrape all visible job cards.
   * Supports TWO LinkedIn DOM layouts:
   *   A) /jobs/search/  → li[data-occludable-job-id] cards
   *   B) /jobs/search-results/ (AI-powered search) → dismiss button aria-labels
   */
  function scrapeJobCards() {
    const _logSafe = (typeof AALog !== "undefined") ? AALog : null;
    _logSafe && _logSafe.scrape("linkedin.scrape.start", { url: location.href });

    // --- Strategy A: data-occludable-job-id (classic search) ---
    const cardItems = document.querySelectorAll("li[data-occludable-job-id]");
    if (cardItems.length > 0) {
      console.log(`AutoApply: Using Strategy A (data-occludable-job-id), found ${cardItems.length} cards`);
      const jobs = scrapeStrategyA(cardItems);
      _logSafe && _logSafe.scrape("linkedin.scrape.strategyA.done", { count: jobs.length, jobs });
      return jobs;
    }

    // --- Strategy B: dismiss button aria-labels (AI-powered search-results) ---
    const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"][aria-label$=" job"]');
    if (dismissBtns.length > 0) {
      console.log(`AutoApply: Using Strategy B (dismiss buttons), found ${dismissBtns.length} cards`);
      const jobs = scrapeStrategyB(dismissBtns);
      _logSafe && _logSafe.scrape("linkedin.scrape.strategyB.done", { count: jobs.length, jobs });
      return jobs;
    }

    console.warn("AutoApply: No job cards found with any strategy");
    _logSafe && _logSafe.error("linkedin.scrape.noCardsFound", { url: location.href, bodyLen: document.body?.innerText?.length || 0 });
    return [];
  }

  /** Strategy A: Classic /jobs/search/ with li[data-occludable-job-id] */
  function scrapeStrategyA(cardItems) {
    const jobs = [];
    cardItems.forEach((card, index) => {
      try {
        const jobId = card.getAttribute("data-occludable-job-id") || "";
        const titleLink = card.querySelector("a.job-card-container__link")
          || card.querySelector('a[href*="/jobs/view/"]')
          || card.querySelector("a");

        let title = "";
        if (titleLink) {
          title = titleLink.getAttribute("aria-label")
            || titleLink.querySelector("strong")?.textContent?.trim()
            || titleLink.querySelector('[class*="title"]')?.textContent?.trim()
            || titleLink.textContent?.trim()
            || "";
        }
        title = title.replace(/\s*\(Verified job\)/gi, "").trim();
        if (!title || title.length < 3) return;

        const { company, location, easyApply } = parseCardText(card.innerText, title);

        jobs.push({
          id: `li_${Date.now()}_${index}`,
          index,
          linkedinJobId: jobId,
          title, company, location, easyApply,
          selected: false, status: "pending",
        });
      } catch (e) {
        console.warn("AutoApply: Failed to parse job card (A)", e);
      }
    });
    return jobs;
  }

  /** Strategy B: AI-powered /jobs/search-results/ with dismiss buttons */
  function scrapeStrategyB(dismissBtns) {
    const jobs = [];
    dismissBtns.forEach((btn, index) => {
      try {
        const label = btn.getAttribute("aria-label") || "";
        const titleMatch = label.match(/^Dismiss (.+?) job$/);
        const title = titleMatch ? titleMatch[1].trim() : "";
        if (!title || title.length < 3) return;

        // Walk up to find card container with text (50-500 chars)
        let card = btn;
        for (let j = 0; j < 6; j++) {
          card = card.parentElement;
          if (!card) break;
          const len = (card.innerText || "").length;
          if (len > 50 && len < 500) break;
        }

        const { company, location, easyApply } = parseCardText(card?.innerText, title);

        jobs.push({
          id: `dismiss_${Date.now()}_${index}`,
          index,
          linkedinJobId: "",
          dismissTitle: title, // used for clicking in Strategy B
          title, company, location, easyApply,
          selected: false, status: "pending",
        });
      } catch (e) {
        console.warn("AutoApply: Failed to parse job card (B)", e);
      }
    });
    return jobs;
  }

  /** Shared: extract company, location, easyApply from card innerText */
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
        location = line;
        break;
      }
    }

    if (!company && lines.length >= 2) company = lines[1]?.replace(/\s*\(Verified job\)/i, "") || "";
    if (!location && lines.length >= 3) location = lines[2] || "";
    const easyApply = text.toLowerCase().includes("easy apply");

    return { company, location, easyApply };
  }

  /**
   * Fetch job data (description + external apply URL) from LinkedIn's server-rendered
   * job page. This is the PRIMARY source — more reliable than panel-scraping/clicking
   * because LinkedIn ignores programmatic/untrusted click events from content scripts.
   *
   * Returns: { description: string|null, applyUrl: string|null }
   */
  async function fetchJobDescription(linkedinJobId, companyHint) {
    if (!linkedinJobId) return { description: null, applyUrl: null };
    try {
      try { AALog && AALog.scrape("linkedin.jd.fetch.start", { jobId: linkedinJobId }); } catch(_){}
      const url = `https://www.linkedin.com/jobs/view/${linkedinJobId}/`;
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) {
        try { AALog && AALog.error("linkedin.jd.fetch.httpError", { status: resp.status, jobId: linkedinJobId }); } catch(_){}
        return { description: null, applyUrl: null };
      }
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      // --- Extract job description ---
      let description = null;
      const jdSelectors = [
        ".show-more-less-html__markup",
        '[class*="show-more-less-html"]',
        ".description__text",
        '[data-test-id="job-details"]',
        ".jobs-description-content__text",
        ".jobs-description__content",
        'section[data-section="description"]',
      ];
      for (const sel of jdSelectors) {
        const el = doc.querySelector(sel);
        const text = (el?.textContent || "").trim();
        if (text.length > 100) { description = text; break; }
      }
      if (!description) {
        let best = "";
        for (const s of doc.querySelectorAll("section, article")) {
          const t = (s.textContent || "").trim();
          if (t.length > best.length && t.length < 50000) best = t;
        }
        if (best.length > 100) description = best;
      }

      // --- Extract external apply URL ---
      // Collect ALL candidate ATS links from the page, then pick the best match.
      // Important: LinkedIn job pages often embed "similar jobs" from other companies
      // in the sidebar/footer — grabbing the first ATS link can return a completely
      // wrong company's URL (e.g. Pixieset's breezy.hr for a Loopio listing).
      const atsPatterns = ["greenhouse.io", "lever.co", "workday", "ashbyhq.com", "icims.com",
        "smartrecruiters.com", "jobvite.com", "successfactors", "taleo.net", "breezy.hr",
        "bamboohr.com", "recruitee.com", "workable.com", "personio.com", "rippling.com",
        "gusto.com/careers", "jazz.co", "applytojob.com", "teamtailor.com", "pinpointhq.com"];
      const candidateUrls = [];
      for (const a of doc.querySelectorAll("a[href]")) {
        const href = a.href || "";
        if (atsPatterns.some((p) => href.includes(p)) && !href.includes("linkedin.com")) {
          candidateUrls.push(href);
        }
      }
      // Fallback: look for any link whose text or aria-label contains "apply"
      // and points to an external site. This catches company-specific career pages
      // (e.g. clear.co/careers) that aren't in the known ATS patterns list.
      if (candidateUrls.length === 0) {
        for (const a of doc.querySelectorAll("a[href]")) {
          const text = (a.textContent || "").trim().toLowerCase();
          const ariaLabel = (a.getAttribute("aria-label") || "").toLowerCase();
          const href = a.href || "";
          const isApplyLink = text === "apply" || text === "apply now" ||
            ariaLabel.includes("apply on") || ariaLabel.includes("apply to") ||
            ariaLabel.startsWith("apply");
          if (isApplyLink && href && href.startsWith("http") && !href.includes("linkedin.com")) {
            candidateUrls.push(href);
          }
        }
      }

      // Pick the best candidate URL. If there are multiple (e.g. sidebar "similar jobs"),
      // prefer the one whose domain/subdomain contains the company name slug.
      let applyUrl = null;
      if (candidateUrls.length === 1) {
        applyUrl = candidateUrls[0];
      } else if (candidateUrls.length > 1) {
        // Build a slug from the company name: "Loopio Inc." → "loopio"
        const companySlug = (companyHint || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .substring(0, 12); // first 12 alphanum chars
        // Score each candidate: +2 if subdomain/path matches company slug, +1 if domain portion matches
        let bestScore = -1;
        for (const url of candidateUrls) {
          let score = 0;
          if (companySlug.length >= 3) {
            const urlLower = url.toLowerCase();
            const hostMatch = urlLower.replace(/https?:\/\//, "").split("/")[0]; // hostname
            if (hostMatch.replace(/[^a-z0-9]/g, "").includes(companySlug)) score += 2;
            else if (urlLower.replace(/[^a-z0-9]/g, "").includes(companySlug)) score += 1;
          }
          if (score > bestScore) { bestScore = score; applyUrl = url; }
        }
        // If no company match, fall back to first candidate (original behavior)
        if (!applyUrl) applyUrl = candidateUrls[0];
        try { AALog && AALog.scrape("linkedin.jd.applyUrlPicked", { companyHint, companySlug, candidates: candidateUrls.length, chosen: applyUrl?.slice(0, 120) }); } catch(_){}
      }

      try {
        AALog && AALog.scrape("linkedin.jd.fetch.done", {
          jobId: linkedinJobId,
          descLen: (description || "").length,
          applyUrl: applyUrl ? applyUrl.slice(0, 120) : null,
        });
      } catch(_){}
      return { description, applyUrl };
    } catch (e) {
      try { AALog && AALog.error("linkedin.jd.fetch.error", { jobId: linkedinJobId, error: e.message }); } catch(_){}
      return { description: null, applyUrl: null };
    }
  }

  /**
   * Scrape JD from the right-side detail panel after clicking a job card.
   * Used as FALLBACK when fetchJobDescription fails or returns empty.
   */
  function scrapeJobDescription() {
    // Strategy 1: "About the job" heading
    const allElements = document.querySelectorAll("h2, h3, h4, span, div");
    for (const el of allElements) {
      const text = el.textContent?.trim();
      if (text === "About the job" || text === "About this job") {
        let container = el.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!container) break;
          const containerText = container.innerText?.trim() || "";
          if (containerText.length > 200) {
            return containerText.replace(/^About the job\s*/i, "").replace(/^About this job\s*/i, "").trim();
          }
          container = container.parentElement;
        }
      }
    }

    // Strategy 2: aria-label containers
    for (const sel of ['[aria-label*="job description"]', '[aria-label*="Job description"]']) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) return el.innerText.trim();
    }

    // Strategy 3: sections with JD keywords
    const allSections = document.querySelectorAll("section, [role='region']");
    for (const section of allSections) {
      const text = section.innerText?.trim() || "";
      if (text.length > 300 && !text.includes("Dismiss") &&
        (text.includes("Responsibilities") || text.includes("Qualifications") ||
          text.includes("Requirements") || text.includes("What you'll do") ||
          text.includes("About the role"))) {
        return text;
      }
    }

    // Strategy 4: longest non-list text block
    const mainContent = document.querySelector("main");
    if (mainContent) {
      let bestText = "";
      for (const div of mainContent.querySelectorAll("div")) {
        if (div.querySelectorAll('button[aria-label*="Dismiss"]').length > 2) continue;
        const text = div.innerText?.trim() || "";
        if (text.length > bestText.length && text.length > 300 && text.length < 10000) {
          bestText = text;
        }
      }
      if (bestText) return bestText;
    }

    return "";
  }

  /**
   * Click a job card by its dismiss button index and wait for detail panel.
   * Falls back to matching by job title if the index has shifted.
   */
  async function clickJobCard(job) {
    let card = null;

    // --- Strategy A cards: li[data-occludable-job-id] ---
    if (job.linkedinJobId) {
      card = document.querySelector(`li[data-occludable-job-id="${job.linkedinJobId}"]`);
    }
    if (!card) {
      const allCards = document.querySelectorAll("li[data-occludable-job-id]");
      if (allCards.length > 0) {
        card = allCards[job.index];
        if (!card && job.title) {
          const titleLower = job.title.toLowerCase();
          for (const candidate of allCards) {
            const linkText = candidate.querySelector("a")?.textContent?.toLowerCase() || "";
            if (linkText.includes(titleLower.substring(0, 25))) { card = candidate; break; }
          }
        }
      }
    }

    // --- Strategy B cards: find via dismiss button aria-label ---
    if (!card && job.dismissTitle) {
      const dismissBtn = document.querySelector(`button[aria-label="Dismiss ${job.dismissTitle} job"]`);
      if (dismissBtn) {
        // Walk up to find clickable card container
        card = dismissBtn;
        for (let j = 0; j < 6; j++) {
          card = card.parentElement;
          if (!card) break;
          const len = (card.innerText || "").length;
          if (len > 50 && len < 500) break;
        }
      }
    }

    // --- Fallback: search all dismiss buttons by title ---
    if (!card && job.title) {
      const titleLower = job.title.toLowerCase();
      const allDismiss = document.querySelectorAll('button[aria-label*="Dismiss"][aria-label$=" job"]');
      for (const btn of allDismiss) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes(titleLower.substring(0, 25))) {
          card = btn;
          for (let j = 0; j < 6; j++) {
            card = card.parentElement;
            if (!card) break;
            const len = (card.innerText || "").length;
            if (len > 50 && len < 500) break;
          }
          break;
        }
      }
    }

    if (!card) {
      console.warn("AutoApply: No job card found for", job.title);
      try { AALog && AALog.error("linkedin.clickCard.notFound", { title: job.title, dismissTitle: job.dismissTitle, jobId: job.id }); } catch(_){}
      return false;
    }

    // Snapshot the detail panel's current content BEFORE clicking, so we
    // can wait for it to actually change after the click. This is what
    // prevents us from scraping the previous job's stale JD.
    const detailSelector =
      '.jobs-search__job-details, .job-details-jobs-unified-top-card, [class*="job-details"], [class*="jobs-details"]';
    const detailBefore = document.querySelector(detailSelector);
    const beforeSnapshot = (detailBefore?.innerText || "").slice(0, 500);

    // If the detail panel already shows this job, skip the click entirely.
    // Re-clicking an already-selected job card can trigger full-page navigation
    // on some LinkedIn job types (e.g. promoted Amazon listings) which kills
    // the content script before the confirmation modal can appear.
    const beforeLower = beforeSnapshot.toLowerCase();
    const titleFirst20already = (job.title || "").toLowerCase().substring(0, 20);
    const companyFirst15already = (job.company || "").toLowerCase().substring(0, 15);
    const alreadyLoaded =
      (titleFirst20already.length >= 4 && beforeLower.includes(titleFirst20already)) ||
      (companyFirst15already.length >= 3 && beforeLower.includes(companyFirst15already));
    if (alreadyLoaded) {
      console.log(`AutoApply: Job "${job.title}" already in detail panel — skipping click`);
      try { AALog && AALog.nav("linkedin.clickCard.alreadyLoaded", { title: job.title }); } catch(_){}
      await new Promise((r) => setTimeout(r, 400));
      return true;
    }

    // Click the title anchor inside the card — LinkedIn's SPA navigation is
    // only triggered by the <a> tag, not the outer <li> container.
    const titleAnchor = card.querySelector('a.job-card-container__link')
      || card.querySelector('a[href*="/jobs/view/"]')
      || card.querySelector('a[href*="/jobs/collections/"]')
      || card.querySelector('a');
    if (titleAnchor) {
      titleAnchor.click();
    } else {
      card.click(); // fallback for Strategy B containers
    }

    // Wait for the detail panel to visibly change. Poll up to 6s in 150ms
    // ticks. If it never changes (same title re-clicked, or LinkedIn is
    // slow), fall back to the original 2.5s sleep so we don't block forever.
    const MAX_WAIT_MS = 6000;
    const TICK_MS = 150;
    const deadline = Date.now() + MAX_WAIT_MS;
    let changed = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, TICK_MS));
      const detailAfter = document.querySelector(detailSelector);
      const afterSnapshot = (detailAfter?.innerText || "").slice(0, 500);
      // Consider it changed when the panel text differs AND contains the job
      // title or company name. If the text changed significantly but doesn't
      // match (e.g. LinkedIn shows a different panel state), still break so we
      // don't waste the full 6s polling budget — log a warning instead.
      if (afterSnapshot && afterSnapshot !== beforeSnapshot) {
        const afterLower = afterSnapshot.toLowerCase();
        const titleFirst20 = (job.title || "").toLowerCase().substring(0, 20);
        const companyFirst15 = (job.company || "").toLowerCase().substring(0, 15);
        const titleMatch = titleFirst20.length >= 4 && afterLower.includes(titleFirst20);
        const companyMatch = companyFirst15.length >= 3 && afterLower.includes(companyFirst15);
        if (titleMatch || companyMatch) {
          changed = true;
          break;
        }
        // Text changed but expected job not confirmed — keep polling but note it
        // (the panel might be mid-render; on the next tick it may confirm)
      }
    }

    try {
      AALog && AALog.nav("linkedin.clickCard.done", {
        title: job.title,
        changed,
        waitedMs: Date.now() - (deadline - MAX_WAIT_MS),
      });
    } catch(_){}

    // Extra settle time so lazy-loaded JD sections finish rendering.
    await new Promise((r) => setTimeout(r, 400));
    return true;
  }

  /**
   * Find and click the Apply button in the detail panel.
   * Returns the type: "external" | "easy_apply" | null
   */
  async function clickApplyButton() {
    // Check if LinkedIn shows this job as already-applied.
    // Three different patterns LinkedIn uses depending on job type:
    //   1. Sidebar card: "Applied · 2 weeks ago · Easy Apply" (middle-dot separator, very specific)
    //   2. Detail panel top card: "Applied 2 weeks ago" (no dot, for external apply)
    //   3. Easy Apply panel: "Application submitted 1 week ago" (for Easy Apply jobs)
    // To avoid false positives from job description text (e.g. "applied X months of experience"),
    // we check the sidebar selected card first (most reliable), then restrict the detail panel
    // check to the FIRST 1200 characters (top card area only, before the JD starts).

    // 1. Check the currently-selected sidebar job card for applied status (most reliable signal)
    const selectedCard = document.querySelector(
      '.job-card-container--selected, .jobs-search-results__list-item--active .job-card-container, [aria-selected="true"] .job-card-container'
    );
    const sidebarText = (selectedCard?.innerText || '').toLowerCase();
    const sidebarApplied = /applied\s*[·•\-]\s*\d+\s*(second|minute|hour|day|week|month)/i.test(sidebarText)
                        || sidebarText.includes("application submitted");

    // 2. Check the top portion of the detail panel (top card only, not the JD)
    const detailPanel = document.querySelector(
      '.jobs-search__job-details, .job-details-jobs-unified-top-card, [class*="job-details"]'
    );
    // Limit to first 1200 chars — the "Applied X ago" badge is in the header area;
    // the job description starts further down and is the source of false positives.
    const topPanelText = (detailPanel?.innerText || '').substring(0, 1200).toLowerCase();
    const panelApplied = /applied\s+\d+\s*(second|minute|hour|day|week|month)/i.test(topPanelText)
                      || topPanelText.includes("application submitted")
                      || topPanelText.includes("see application");

    if (sidebarApplied || panelApplied) {
      console.log("AutoApply: Already applied to this job (LinkedIn shows applied status) — skipping");
      try { AALog && AALog.nav("linkedin.clickApply.alreadyApplied", { sidebarApplied, panelApplied, sidebarPreview: sidebarText.slice(0, 200), topPanelPreview: topPanelText.slice(0, 200) }); } catch(_){}
      return "already_applied";
    }

    // Look for apply buttons in the detail panel (right side)
    const allButtons = document.querySelectorAll("button, a");
    try { AALog && AALog.nav("linkedin.clickApply.scanStart", { totalButtons: allButtons.length, detailPanelFound: !!detailPanel, topPanelLen: (detailPanel?.innerText || "").length }); } catch(_){}

    let bestApplyBtn = null;
    let bestType = null;
    // Collect a diagnostic list of every candidate we considered so we can
    // see exactly why nothing matched when applyType comes back null.
    const candidates = [];

    for (const btn of allButtons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      const href = (btn.getAttribute("href") || "").toLowerCase();

      // Skip if it's inside the job list sidebar (left panel), NOT the detail panel (right)
      if (btn.closest && btn.closest('.jobs-search-results-list, .scaffold-layout__list')) continue;
      // Skip filter buttons (e.g. "Easy Apply" filter in the top toolbar)
      if (ariaLabel.includes("filter")) continue;
      // Skip tiny or hidden buttons
      if (btn.offsetWidth < 30 || btn.offsetHeight < 15) continue;
      // Skip "Save" / "Share" / "Report" buttons
      if (text.includes("save") || text.includes("share") || text.includes("report")) continue;
      // Skip our own extension buttons
      if (btn.closest && btn.closest('#autoapply-panel, #autoapply-confirm-modal, #autoapply-progress-overlay')) continue;

      // Detect Easy Apply (actual Apply button, not the filter)
      if (text.includes("easy apply") && !ariaLabel.includes("filter")) {
        bestApplyBtn = btn;
        bestType = "easy_apply";
        candidates.push({ kind: "easy_apply", text: text.slice(0, 60), ariaLabel: ariaLabel.slice(0, 80) });
        continue; // Keep looking for an external Apply button which takes priority
      }

      // External Apply button — detect both "apply" text and "apply on company website" variants
      const isApplyText = (
        text === "apply" ||
        text === "apply now" ||
        text === "apply on company website" ||
        text === "apply on employer site" ||
        text.startsWith("apply") && text.length < 35 && !text.includes("easy")
      );
      const isApplyAria = (
        ariaLabel.includes("apply to") ||
        ariaLabel.includes("apply for") ||
        ariaLabel.includes("apply on") ||
        ariaLabel.includes("apply now")
      );
      if ((isApplyText || isApplyAria) && !text.includes("easy")) {
        candidates.push({ kind: "apply_candidate", text: text.slice(0, 60), ariaLabel: ariaLabel.slice(0, 80), tag: btn.tagName, href: href.slice(0, 80) });
        // Prefer buttons that link to external company website
        if (btn.tagName === "A" || href || btn.querySelector("svg") ||
            ariaLabel.includes("opens") || ariaLabel.includes("company website") ||
            ariaLabel.includes("on company")) {
          bestApplyBtn = btn;
          bestType = "external";
          break; // External apply takes priority — stop looking
        }
        // Regular button with "Apply" text
        if (!bestApplyBtn || bestType !== "external") {
          bestApplyBtn = btn;
          bestType = "external";
        }
      }
    }

    if (!bestApplyBtn) {
      // Diagnostic: scan for any button/link with "apply" in its text or aria
      // to help figure out why nothing matched. Include what the top card
      // looks like so we can inspect DOM structure remotely.
      const loose = [];
      for (const btn of allButtons) {
        const t = (btn.textContent || "").trim().toLowerCase();
        const a = (btn.getAttribute("aria-label") || "").toLowerCase();
        if ((t.includes("apply") || a.includes("apply")) && loose.length < 20) {
          loose.push({
            text: t.slice(0, 60),
            aria: a.slice(0, 80),
            tag: btn.tagName,
            inSidebar: !!(btn.closest && btn.closest('.jobs-search-results-list, .scaffold-layout__list')),
            w: btn.offsetWidth, h: btn.offsetHeight,
          });
        }
      }
      try {
        AALog && AALog.error("linkedin.clickApply.noButton", {
          candidates,
          looseMatches: loose,
          topPanelPreview: (detailPanel?.innerText || "").slice(0, 600),
        });
      } catch(_){}
      return null;
    }

    if (bestType === "easy_apply") {
      // Don't click Easy Apply — just report it
      try { AALog && AALog.nav("linkedin.clickApply.easyApply", { candidates }); } catch(_){}
      return "easy_apply";
    }

    // External apply — click it
    const btnLabel = bestApplyBtn.getAttribute("aria-label") || bestApplyBtn.textContent.trim();
    console.log("AutoApply: Clicking external Apply button: " + btnLabel);
    try { AALog && AALog.nav("linkedin.clickApply.external", { label: btnLabel, candidates }); } catch(_){}
    bestApplyBtn.click();
    await new Promise((r) => setTimeout(r, 1500));
    return "external";
  }

  /* ─────────────────────── AUTO-APPLY ENGINE ─────────────────────── */

  /**
   * Scroll the job detail panel to load the full description.
   * LinkedIn lazy-loads content — we need to scroll down to reveal "About the job".
   */
  async function scrollDetailPanel() {
    // Find the scrollable detail panel (right side of the job search layout)
    const detailPanels = document.querySelectorAll(
      '[class*="jobs-search__job-details"], [class*="job-details"], [role="main"], main'
    );

    // Also try finding a scrollable container that ISN'T the job list
    const allScrollable = document.querySelectorAll("div, section");
    let detailPanel = null;

    for (const el of allScrollable) {
      // Must be scrollable
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      // Must not contain the job list (dismiss buttons)
      if (el.querySelectorAll('button[aria-label*="Dismiss"]').length > 2) continue;
      // Must have substantial content
      if (el.innerText?.length > 200) {
        detailPanel = el;
        break;
      }
    }

    if (!detailPanel) {
      // Fallback: scroll the whole page
      detailPanel = document.documentElement;
    }

    // Scroll down in increments to trigger lazy loading
    const scrollStep = 500;
    const maxScrolls = 8;
    for (let i = 0; i < maxScrolls; i++) {
      detailPanel.scrollTop += scrollStep;
      await new Promise((r) => setTimeout(r, 400));

      // Check if "About the job" is now visible
      const aboutHeading = document.querySelector("h2, h3, h4, span");
      // Quick check in all elements
      const allEls = document.querySelectorAll("h2, h3, h4, span");
      for (const el of allEls) {
        if (el.textContent?.trim() === "About the job") {
          // Found it — scroll a bit more to load full content
          detailPanel.scrollTop += scrollStep;
          await new Promise((r) => setTimeout(r, 500));
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Verify that the LinkedIn detail panel currently shows the expected job.
   * Returns true only when the panel text confirms BOTH the job title AND company name.
   *
   * Using OR (title || company) causes false positives when two jobs share the same
   * title (e.g. "Senior Product Manager" at Clearco AND at Fluxon) — the wrong
   * company's panel would still pass the title-only check. Requiring AND prevents
   * clicking the wrong Apply button.
   */
  function isPanelShowingJob(job) {
    const detailSelector =
      '.jobs-search__job-details, .job-details-jobs-unified-top-card, [class*="job-details"], [class*="jobs-details"]';
    const panel = document.querySelector(detailSelector);
    if (!panel) return false;
    const fullPanelText = (panel.innerText || "").toLowerCase();
    if (!fullPanelText) return false;
    // Use a tight 500-char window for header-area checks (company/title appear first)
    const headerText = fullPanelText.slice(0, 500);
    const titleFirst25 = (job.title || "").toLowerCase().substring(0, 25);
    const companyFirst20 = (job.company || "").toLowerCase().substring(0, 20);
    const titleMatch = titleFirst25.length >= 4 && headerText.includes(titleFirst25);
    // Company match: check both header (strong) and broader text (weaker)
    const companyInHeader = companyFirst20.length >= 3 && headerText.includes(companyFirst20);
    const companyInPage   = companyFirst20.length >= 5 && fullPanelText.slice(0, 800).includes(companyFirst20);

    // Company confirmed in header = high confidence, accept it alone
    if (companyInHeader) return true;
    // Title match + company anywhere in page = good enough
    if (titleMatch && companyInPage) return true;
    // Title alone when it's long and unique enough
    if (titleMatch && titleFirst25.length >= 20) return true;
    return false;
  }

  /**
   * Process a single job: click card → scroll → scrape JD → click Apply → notify background
   */
  async function processJob(job) {
    updateJobStatus(job.id, "applying", "Loading job details...");
    updateStatus(`Applying: ${job.title} at ${job.company}...`);

    try {
      // Step 1: Click the job card to load detail panel
      const clicked = await clickJobCard(job);
      if (!clicked) {
        console.warn("AutoApply: Could not click job card for", job.title, "at index", job.index);
        updateJobStatus(job.id, "failed");
        return { success: false, reason: "Could not click job card" };
      }

      // Step 1b: Verify the detail panel actually switched to the correct job.
      // Poll with increasing patience — LinkedIn sometimes takes 3-4s to render
      // promoted listings (e.g. MongoDB "Be an early applicant" jobs).
      let panelOk = isPanelShowingJob(job);
      if (!panelOk) {
        // Wait up to 4s total in 500ms ticks for the panel to confirm
        for (let attempt = 0; attempt < 8 && !panelOk; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          panelOk = isPanelShowingJob(job);
        }
      }
      if (!panelOk) {
        // Re-click once and give another 4s
        console.warn(`AutoApply: Panel mismatch after click for "${job.title}" — retrying card click`);
        try { AALog && AALog.error("linkedin.processJob.panelMismatch", { title: job.title, company: job.company }); } catch(_){}
        await clickJobCard(job);
        for (let attempt = 0; attempt < 8 && !panelOk; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          panelOk = isPanelShowingJob(job);
        }
      }
      if (!panelOk) {
        console.error(`AutoApply: Panel still not showing "${job.title}" after retry — aborting to avoid wrong-tab apply`);
        try { AALog && AALog.error("linkedin.processJob.panelMismatchAbort", { title: job.title, company: job.company }); } catch(_){}
        const reason = "Panel mismatch — LinkedIn didn't load this job's details in time";
        updateJobStatus(job.id, "failed", reason);
        return { success: false, reason };
      }

      // Step 2: Scroll the detail panel to load the full JD
      updateJobStatus(job.id, "applying", "Reading job description...");
      await scrollDetailPanel();
      await new Promise((r) => setTimeout(r, 600));

      // Step 3: Scrape the JD from the detail panel
      let jobDescription = scrapeJobDescription();
      if (!jobDescription || jobDescription.length < 50) {
        await scrollDetailPanel();
        await new Promise((r) => setTimeout(r, 600));
        jobDescription = scrapeJobDescription();
        if (!jobDescription || jobDescription.length < 50) {
          updateJobStatus(job.id, "failed");
          return { success: false, reason: "Could not scrape job description" };
        }
      }

      // Step 3: Final safety check — confirm panel still shows the right job before
      // sending PREPARE_APPLICATION. This guards against the panel swapping to a
      // different job between the card-click and the JD scrape (e.g. a race where
      // LinkedIn auto-selects a promoted listing). Wait briefly if still loading.
      let finalPanelOk = isPanelShowingJob(job);
      if (!finalPanelOk) {
        await new Promise((r) => setTimeout(r, 1500));
        finalPanelOk = isPanelShowingJob(job);
      }
      if (!finalPanelOk) {
        console.error(`AutoApply: Panel no longer shows "${job.title}" before PREPARE_APPLICATION — aborting`);
        try { AALog && AALog.error("linkedin.processJob.panelChangedBeforePrepare", { title: job.title, company: job.company }); } catch(_){}
        const reason = "Panel changed before apply — LinkedIn switched to a different listing";
        updateJobStatus(job.id, "failed", reason);
        return { success: false, reason };
      }

      // Step 3: Store job + JD in background so ATS scripts can pick it up
      updateJobStatus(job.id, "applying", "Scanning job description...");
      const jobData = {
        jobTitle: job.title,
        company: job.company,
        location: job.location,
        jobDescription,
        easyApply: job.easyApply,
        source: "linkedin",
      };

      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "PREPARE_APPLICATION",
          job: jobData,
        }, resolve);
      });

      // Step 4: Click the Apply button
      updateJobStatus(job.id, "applying", "Opening application...");
      const applyType = await clickApplyButton();

      if (applyType === "external") {
        // External site opened in new tab — mark as "opened", NOT "applied"
        // Only the ATS script should mark "applied" after the user actually submits
        updateJobStatus(job.id, "opened");
        appliedCount++;
        updateStatus(`Tab opened: ${job.title}. ATS will auto-fill the form...`);
        // Wait for external tab to open + background to detect it + ATS to inject
        // Must be long enough for background.js expectingNewTab to be consumed
        await new Promise((r) => setTimeout(r, 5000));
        return { success: true, type: "external" };
      } else if (applyType === "easy_apply") {
        // Skip Easy Apply for now — we're focused on external
        updateJobStatus(job.id, "skipped");
        skippedCount++;
        updateStatus(`Skipped (Easy Apply): ${job.title}`);
        return { success: false, reason: "Easy Apply — skipped" };
      } else if (applyType === "already_applied") {
        // Already applied — skip, don't count as failure
        updateJobStatus(job.id, "skipped");
        skippedCount++;
        updateStatus(`Skipped (already applied): ${job.title}`);
        try { AALog && AALog.nav("linkedin.processJob.alreadyApplied", { title: job.title, company: job.company }); } catch(_){}
        return { success: false, reason: "Already applied" };
      } else {
        // null — no Apply button found — log the reason clearly
        const reason = "No Apply button found — check extension logs for candidates";
        updateJobStatus(job.id, "failed", reason);
        try { AALog && AALog.error("linkedin.processJob.noApplyButton", { title: job.title, company: job.company }); } catch(_){}
        return { success: false, reason };
      }
    } catch (e) {
      console.error("AutoApply: Error processing job", job.title, e);
      updateJobStatus(job.id, "failed");
      return { success: false, reason: e.message };
    }
  }

  /* ─────────────── RESUME CONFIRMATION MODAL ─────────────── */

  function createConfirmationModal() {
    let modal = document.getElementById("autoapply-confirm-modal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "autoapply-confirm-modal";
    modal.style.cssText = `
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 100000; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: none; align-items: center; justify-content: center;
    `;
    modal.innerHTML = `
      <div style="
        background: white; border-radius: 16px; width: 500px; max-height: 80vh;
        overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      ">
        <div style="
          padding: 20px; border-bottom: 1px solid #E5E5E5;
          display: flex; align-items: center; justify-content: space-between;
        ">
          <div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span id="confirm-step" style="
                background: #4F46E5; color: white; font-size: 12px; font-weight: 700;
                padding: 3px 10px; border-radius: 6px;
              ">Job 1/5</span>
              <span style="font-size: 11px; color: #999;">Review before applying</span>
            </div>
            <h3 id="confirm-title" style="margin: 8px 0 2px; font-size: 16px; font-weight: 600; color: #111;">Job Title</h3>
            <p id="confirm-company" style="margin: 0; font-size: 13px; color: #4F46E5; font-weight: 500;">Company — Location</p>
          </div>
        </div>

        <div style="padding: 16px 20px; border-bottom: 1px solid #E5E5E5;">
          <h4 style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Job Description</h4>
          <div id="confirm-resume-preview" style="
            font-size: 11px; color: #333; line-height: 1.5; max-height: 200px;
            overflow-y: auto; background: #FAFAFA; border-radius: 8px; padding: 12px;
            border: 1px solid #E5E5E5;
          ">Loading job description...</div>
          <div id="confirm-match-score" style="
            margin-top: 8px; display: flex; align-items: center; gap: 12px;
          ">
            <span style="font-size: 11px; color: #666;">Match Score:</span>
            <span id="confirm-score-value" style="font-size: 14px; font-weight: 700; color: #4F46E5;">—</span>
            <span id="confirm-jd-chars" style="font-size: 10px; color: #9CA3AF; margin-left: auto;">— chars sent to AI</span>
          </div>
        </div>

        <div style="padding: 16px 20px; display: flex; gap: 10px; flex-wrap: wrap;">
          <button id="confirm-prev" style="
            background: #F9FAFB; color: #374151; border: 1px solid #D1D5DB; border-radius: 8px;
            padding: 12px 14px; font-size: 13px; font-weight: 500; cursor: pointer;
            display: none;
          " title="Go back to the previous job">← Back</button>
          <button id="confirm-apply" style="
            flex: 1; background: #4F46E5; color: white; border: none; border-radius: 8px;
            padding: 12px; font-size: 13px; font-weight: 600; cursor: pointer;
          ">Apply with this Resume</button>
          <button id="confirm-skip" style="
            background: #F5F5F5; color: #666; border: 1px solid #E5E5E5; border-radius: 8px;
            padding: 12px 20px; font-size: 13px; font-weight: 500; cursor: pointer;
          ">Skip</button>
          <button id="confirm-stop" style="
            background: #FEE2E2; color: #991B1B; border: 1px solid #FECACA; border-radius: 8px;
            padding: 12px 16px; font-size: 13px; font-weight: 500; cursor: pointer;
          ">Stop All</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  /**
   * Show the confirmation modal for a job and wait for user decision.
   * Returns: "apply" | "skip" | "stop" | "previous"
   * hasPrevious — if true, the ← Back button is shown so user can go back.
   */
  function showConfirmation(jobNumber, totalJobs, job, tailoredResult, jobDescription, hasPrevious = false) {
    return new Promise((resolve) => {
      const modal = createConfirmationModal();
      modal.style.display = "flex";

      // [Fix 2026-04-08] Guard against null getElementById — these elements are created in
      // createConfirmationModal() but could be absent if the DOM was modified externally
      // (e.g., host page removes injected elements). Optional-chain assignment prevents
      // the "Cannot read properties of null (reading 'textContent')" crash.
      const _csStep = document.getElementById("confirm-step");
      const _csTitle = document.getElementById("confirm-title");
      const _csCompany = document.getElementById("confirm-company");
      if (_csStep) _csStep.textContent = `Job ${jobNumber}/${totalJobs}`;
      if (_csTitle) _csTitle.textContent = job.title;
      if (_csCompany) _csCompany.textContent = `${job.company} — ${job.location}`;

      // Show/hide Back button based on position in queue
      const prevBtn = document.getElementById("confirm-prev");
      if (prevBtn) prevBtn.style.display = hasPrevious ? "block" : "none";

      const preview = document.getElementById("confirm-resume-preview");
      const scoreEl = document.getElementById("confirm-score-value");
      const jdCharsEl = document.getElementById("confirm-jd-chars");

      // Show full job description so user can verify the right JD was scraped.
      // The box is scrollable — no truncation here. Full text is also what AI receives.
      const jdText = jobDescription ? jobDescription.trim() : "";
      preview.textContent = jdText || "Job description not available.";
      if (jdCharsEl) {
        jdCharsEl.textContent = jdText ? `${jdText.length.toLocaleString()} chars sent to AI` : "No JD scraped";
        jdCharsEl.style.color = jdText.length < 200 ? "#DC2626" : "#9CA3AF"; // red if suspiciously short
      }

      // Show match score from tailoring result (JD preview is already set above)
      if (tailoredResult) {
        scoreEl.textContent = (tailoredResult.matchScore || 0) + "%";
        scoreEl.style.color = tailoredResult.matchScore >= 70 ? "#059669" : tailoredResult.matchScore >= 50 ? "#D97706" : "#DC2626";
      } else {
        scoreEl.textContent = "—";
      }

      const cleanup = () => {
        modal.style.display = "none";
        applyBtn.removeEventListener("click", onApply);
        skipBtn.removeEventListener("click", onSkip);
        stopBtn.removeEventListener("click", onStop);
        if (prevBtn) prevBtn.removeEventListener("click", onPrev);
      };

      const applyBtn = document.getElementById("confirm-apply");
      const skipBtn  = document.getElementById("confirm-skip");
      const stopBtn  = document.getElementById("confirm-stop");

      const onApply    = () => { cleanup(); resolve("apply"); };
      const onSkip     = () => { cleanup(); resolve("skip"); };
      const onStop     = () => { cleanup(); resolve("stop"); };
      const onPrev     = () => { cleanup(); resolve("previous"); };

      applyBtn.addEventListener("click", onApply);
      skipBtn.addEventListener("click", onSkip);
      stopBtn.addEventListener("click", onStop);
      if (prevBtn) prevBtn.addEventListener("click", onPrev);
    });
  }

  /**
   * Run the auto-apply loop for all selected jobs.
   * Shows a confirmation modal for each job so the user stays in the loop.
   */
  async function startApplying() {
    const selectedJobs = scrapedJobs.filter((j) => selectedJobIds.has(j.id));
    if (selectedJobs.length === 0) return;

    try { AALog && AALog.state("batch.start", { total: selectedJobs.length, jobs: selectedJobs.map(j => ({ id: j.id, title: j.title, company: j.company })) }); } catch(_){}

    isApplying = true;
    skipRequested = false;
    appliedCount = 0;
    skippedCount = 0;
    currentJobIndex = 0;
    renderJobList();
    updateActionBar();

    // Get resume from storage (user should have uploaded it via the pipeline page)
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(["resumeText", "parsedResume", "autoapplyUrl"], resolve);
    });

    if (!stored.parsedResume) {
      updateStatus("No resume found. Upload your resume on the AutoApply pipeline page first.", "error");
      isApplying = false;
      renderJobList();
      updateStartButton();
      return;
    }

    for (let i = 0; i < selectedJobs.length; i++) {
      if (!isApplying) break; // User stopped
      if (skipRequested) { skipRequested = false; continue; } // User skipped before this job started

      currentJobIndex = i;
      const job = selectedJobs[i];
      const jobNumber = i + 1;

      try { AALog && AALog.state("batch.jobStart", { jobNumber, total: selectedJobs.length, job }); } catch(_){}

      // Step 1: Click job card to load JD
      showProgressOverlay(jobNumber, selectedJobs.length, job);
      updateJobStatus(job.id, "applying", "Loading job details...");
      updateActionBar();

      const clicked = await clickJobCard(job);
      if (!clicked || skipRequested) {
        skipRequested = false;
        updateJobStatus(job.id, skipRequested ? "skipped" : "failed");
        continue;
      }

      updateJobStatus(job.id, "applying", "Reading job description...");
      if (skipRequested) { skipRequested = false; updateJobStatus(job.id, "skipped"); skippedCount++; continue; }

      // Primary: fetch JD directly from LinkedIn's server-rendered job page.
      // This bypasses the UI navigation issue (LinkedIn ignores untrusted programmatic clicks).
      // Fallback: scrape from the detail panel if fetch fails.
      const fetched = await fetchJobDescription(job.linkedinJobId, job.company);
      let jobDescription = fetched.description;
      let fetchedApplyUrl = fetched.applyUrl; // May be null; used later to open the ATS tab
      if (!jobDescription || jobDescription.length < 50) {
        await scrollDetailPanel();
        await new Promise((r) => setTimeout(r, 800));
        jobDescription = scrapeJobDescription();
        fetchedApplyUrl = null; // Panel scrape: must use clickApplyButton() instead
      }
      try { AALog && AALog.scrape("linkedin.jd.scraped", { jobId: job.id, title: job.title, jdLen: (jobDescription || "").length, jdPreview: (jobDescription || "").slice(0, 400), fetchedApplyUrl: fetchedApplyUrl ? fetchedApplyUrl.slice(0, 100) : null }); } catch(_){}

      // Step 2: JD is ready — show confirmation immediately, no tailoring on LinkedIn side.
      // Tailoring happens on the company ATS page in the background while Step 1 fills.
      updateJobStatus(job.id, "applying", "Scanning job description...");
      const jobData = {
        jobTitle: job.title, company: job.company,
        location: job.location, jobDescription,
        easyApply: job.easyApply, source: "linkedin",
      };

      // Step 3: Show confirmation modal immediately — user verifies JD, then we open the ATS
      updateStatus(`Review job ${jobNumber}/${selectedJobs.length}: ${job.title}`);
      const decision = await showConfirmation(
        jobNumber, selectedJobs.length, job, null, jobDescription,
        /* hasPrevious */ i > 0
      );

      if (decision === "stop") {
        stopApplying();
        break;
      }

      if (!isApplying) break; // Stop was clicked externally (panel button) while modal was open

      if (decision === "previous") {
        // Reset the current job's status so it shows as pending again
        updateJobStatus(job.id, "pending");
        // Go back to the previous job. The for-loop will increment i at the end
        // of this iteration, so we need to subtract 2 to land on i-1.
        // We also reset the previous job's status in case it was skipped/opened,
        // so the user can make a fresh decision.
        if (i > 0) {
          const prevJob = selectedJobs[i - 1];
          if (prevJob && (prevJob.status === "skipped" || prevJob.status === "opened" || prevJob.status === "applying")) {
            updateJobStatus(prevJob.id, "pending");
            if (prevJob.status === "skipped") skippedCount = Math.max(0, skippedCount - 1);
            if (prevJob.status === "opened") appliedCount = Math.max(0, appliedCount - 1);
          }
          i -= 2; // for-loop will do i++ → ends up at i-1
        }
        continue;
      }

      if (decision === "skip") {
        updateJobStatus(job.id, "skipped");
        skippedCount++;
        updateStatus(`Skipped: ${job.title}`);
        continue;
      }

      // decision === "apply" — proceed
      // Store batch progress for ATS tabs
      await new Promise((resolve) => {
        chrome.storage.local.set({
          _aa_currentJobNumber: jobNumber,
          _aa_totalJobs: selectedJobs.length,
          _aa_batchProgress: {
            current: jobNumber, total: selectedJobs.length,
            title: job.title, jobTitle: job.title, company: job.company, location: job.location,
            applied: appliedCount, skipped: skippedCount, active: true,
          },
        }, resolve);
      });

      // Store pending application for ATS script
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "PREPARE_APPLICATION", job: jobData }, resolve);
      });

      // Step 4: Open the ATS application page.
      // If we obtained an external apply URL from the fetched job page, open it directly.
      // Otherwise fall back to clicking the LinkedIn Apply button in the detail panel.
      showProgressOverlay(jobNumber, selectedJobs.length, job);
      updateJobStatus(job.id, "applying", "Opening application...");

      let applyType = null;
      if (fetchedApplyUrl) {
        // Open the external ATS URL directly — no need to click the LinkedIn Apply button
        try { AALog && AALog.nav("linkedin.apply.fetchedUrl", { jobId: job.id, url: fetchedApplyUrl.slice(0, 120) }); } catch(_){}
        const openRes = await new Promise(resolve =>
          chrome.runtime.sendMessage({ type: "OPEN_ATS_TAB", url: fetchedApplyUrl }, resolve)
        );
        if (openRes?.tabId) job.atsTabId = openRes.tabId;
        applyType = "external";
      } else {
        // Re-click the job card to make sure the correct detail panel is loaded.
        // The confirmation modal may have taken time, during which LinkedIn could
        // have changed the detail panel to a different job (e.g. a promoted listing
        // auto-selected by LinkedIn's SPA — this is what causes Fluxon to open for Clearco).
        updateJobStatus(job.id, "applying", "Opening application...");
        await clickJobCard(job);

        // Verify the panel actually shows the right job before clicking Apply.
        // Poll up to 5 seconds in 300ms ticks instead of a fixed sleep.
        let panelReady = false;
        const panelDeadline = Date.now() + 5000;
        while (Date.now() < panelDeadline) {
          await new Promise((r) => setTimeout(r, 300));
          if (isPanelShowingJob(job)) { panelReady = true; break; }
        }

        if (!panelReady) {
          // One retry: re-click and wait again
          console.warn(`AutoApply: Panel not showing "${job.title}" — retrying card click`);
          try { AALog && AALog.error("linkedin.startApplying.panelMismatch", { title: job.title, company: job.company }); } catch(_){}
          await clickJobCard(job);
          const retryDeadline = Date.now() + 4000;
          while (Date.now() < retryDeadline) {
            await new Promise((r) => setTimeout(r, 300));
            if (isPanelShowingJob(job)) { panelReady = true; break; }
          }
        }

        if (!panelReady) {
          console.error(`AutoApply: Panel still not showing "${job.title}" — aborting to avoid wrong Apply click`);
          try { AALog && AALog.error("linkedin.startApplying.panelMismatchAbort", { title: job.title, company: job.company }); } catch(_){}
          updateJobStatus(job.id, "failed");
          continue; // Skip this job rather than open the wrong company's ATS
        }

        try { AALog && AALog.nav("linkedin.apply.click", { jobId: job.id }); } catch(_){}
        applyType = await clickApplyButton();
        try { AALog && AALog.nav("linkedin.apply.result", { jobId: job.id, applyType }); } catch(_){}
      }

      if (!isApplying) break; // Stop clicked while opening ATS

      if (applyType === "external") {
        // Capture the ATS tab ID for the "Continue" button
        const atsTabId = await new Promise((resolve) => {
          chrome.storage.local.get(["_aa_lastAtsTabId"], (r) => resolve(r._aa_lastAtsTabId || null));
        });
        job.atsTabId = atsTabId;
        updateJobStatus(job.id, "opened");
        appliedCount++;
        updateStatus(`Tab opened: ${job.title}. ATS auto-filling...`);
        await new Promise((r) => setTimeout(r, 3000));
        if (!isApplying) break; // Stop clicked during post-open wait
      } else if (applyType === "easy_apply") {
        updateJobStatus(job.id, "skipped");
        skippedCount++;
        updateStatus(`Skipped (Easy Apply): ${job.title}`);
      } else if (applyType === "already_applied") {
        updateJobStatus(job.id, "skipped");
        skippedCount++;
        updateStatus(`Already applied: ${job.title}`);
      } else {
        updateJobStatus(job.id, "failed", "Apply button not found — may be Easy Apply or already applied");
        try { AALog && AALog.error("linkedin.apply.failed", { jobId: job.id, applyType }); } catch(_){}
      }

      // Brief pause between jobs
      if (i < selectedJobs.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    isApplying = false;
    hideProgressOverlay();
    chrome.storage.local.set({ _aa_batchProgress: { active: false, applied: appliedCount, skipped: skippedCount } });
    updateStatus(`Done! ${appliedCount} applied, ${skippedCount} skipped.`, "success");
    renderJobList();
  }

  function stopApplying() {
    isApplying = false;
    skipRequested = false;
    hideProgressOverlay();
    // Close the confirmation modal if it is currently blocking the UI
    const modal = document.getElementById("autoapply-confirm-modal");
    if (modal) modal.style.display = "none";
    chrome.storage.local.set({ _aa_batchProgress: { active: false } });
    updateStatus("Stopped.", "error");
    updateActionBar();
  }

  /** Signal the batch loop to abandon the current job and move to the next one. */
  function requestSkip() {
    skipRequested = true;
    const applyingJob = scrapedJobs.find(j => j.status === "applying");
    if (applyingJob) {
      updateJobStatus(applyingJob.id, "skipped");
      skippedCount++;
    }
    updateStatus("Skipping current job...");
    updateActionBar();
  }

  /** Re-scan the page for new job cards, clearing prior results. */
  function requestReScan() {
    scrapedJobs = scrapeJobCards();
    selectedJobIds.clear();
    persistState();
    renderJobList();
    updateStatus(`Found ${scrapedJobs.length} jobs on this page`);
    updateActionBar();
  }

  /**
   * Render context-aware quick-action buttons above the Stop button.
   * Called from updateJobStatus, stopApplying, and renderJobList.
   */
  function updateActionBar() {
    const bar = document.getElementById("autoapply-action-bar");
    if (!bar) return;

    if (!isApplying) {
      // Not in a batch — show Re-Scan shortcut if jobs are stale
      bar.style.display = scrapedJobs.length > 0 ? "flex" : "none";
      bar.innerHTML = scrapedJobs.length > 0 ? `
        <button id="aa-action-rescan" style="
          flex:1; background:#F5F5F5; border:1px solid #E5E5E5; border-radius:6px;
          padding:6px 10px; font-size:11px; font-weight:600; cursor:pointer; color:#374151;
        ">🔍 Re-Scan Page</button>` : "";
      const rescanBtn = document.getElementById("aa-action-rescan");
      if (rescanBtn) rescanBtn.addEventListener("click", requestReScan);
      return;
    }

    // During a batch run — show skip + optional retry
    const applyingJob = scrapedJobs.find(j => j.status === "applying");
    const hasFailedJob = scrapedJobs.some(j => j.status === "failed");

    bar.style.display = "flex";
    bar.innerHTML = `
      <button id="aa-action-skip" style="
        flex:1; background:#FEF3C7; border:1px solid #FCD34D; border-radius:6px;
        padding:6px 8px; font-size:11px; font-weight:600; cursor:pointer; color:#92400E;
        ${applyingJob ? "" : "opacity:0.4;pointer-events:none;"}
      ">⏭ Skip Job</button>
      <button id="aa-action-rescan" style="
        flex:1; background:#F5F5F5; border:1px solid #E5E5E5; border-radius:6px;
        padding:6px 8px; font-size:11px; font-weight:600; cursor:pointer; color:#374151;
      ">🔍 Re-Scan</button>
    `;

    document.getElementById("aa-action-skip")?.addEventListener("click", () => {
      if (applyingJob) requestSkip();
    });
    document.getElementById("aa-action-rescan")?.addEventListener("click", requestReScan);
  }

  /* ─────────────────────── UI ─────────────────────── */

  function updateStatus(msg, type = "info") {
    const el = document.getElementById("autoapply-status");
    if (el) {
      el.textContent = msg;
      el.style.color = type === "error" ? "#EF4444" : type === "success" ? "#10B981" : "#999";
      el.style.fontWeight = type === "error" ? "600" : "400";
    }
  }

  /* ── Progress Overlay ── */

  function createProgressOverlay() {
    let overlay = document.getElementById("autoapply-progress-overlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "autoapply-progress-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0;
      z-index: 99999; padding: 0;
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: none; transition: all 0.3s ease;
    `;
    overlay.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 24px;">
        <div style="display: flex; align-items: center; gap: 16px;">
          <div style="
            background: rgba(255,255,255,0.2); border-radius: 10px; padding: 6px 14px;
            font-size: 22px; font-weight: 800; color: white; letter-spacing: -0.5px;
          " id="progress-counter">Job 0/0</div>
          <div>
            <p style="margin: 0; font-size: 13px; font-weight: 600; color: white;" id="progress-job-title">—</p>
            <p style="margin: 2px 0 0; font-size: 11px; color: rgba(255,255,255,0.75);" id="progress-job-detail">—</p>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 11px; color: rgba(255,255,255,0.8);" id="progress-stats"></span>
        </div>
      </div>
      <div style="height: 4px; background: rgba(255,255,255,0.15);">
        <div id="progress-bar" style="height: 100%; background: #34D399; width: 0%; transition: width 0.5s ease; border-radius: 0 2px 2px 0;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function showProgressOverlay(index, total, job) {
    const overlay = createProgressOverlay();
    overlay.style.display = "block";

    const counter = document.getElementById("progress-counter");
    const title = document.getElementById("progress-job-title");
    const detail = document.getElementById("progress-job-detail");
    const stats = document.getElementById("progress-stats");
    const bar = document.getElementById("progress-bar");

    if (counter) counter.textContent = `Job ${index}/${total}`;
    if (title) title.textContent = job.title;
    if (detail) detail.textContent = `${job.company} — ${job.location}`;
    if (stats) stats.textContent = `${appliedCount} applied · ${skippedCount} skipped`;
    if (bar) bar.style.width = `${Math.round((index / total) * 100)}%`;
  }

  function hideProgressOverlay() {
    const overlay = document.getElementById("autoapply-progress-overlay");
    if (overlay) overlay.style.display = "none";
  }

  function updateJobStatus(jobId, status, statusText = "") {
    const job = scrapedJobs.find((j) => j.id === jobId);
    if (job) {
      job.status = status;
      if (statusText) job.statusText = statusText;
      // Track when we started processing this job (for elapsed timer)
      if (status === "applying" && !job.startedAt) job.startedAt = Date.now();
      if (status !== "applying") {
        job.startedAt = null;
        // Preserve failure reasons — only clear statusText for non-failed transitions
        if (status === "failed" && statusText) {
          job.failReason = statusText; // Persists across renders
        } else if (status !== "failed") {
          job.statusText = "";
        }
      }
    }
    persistState();
    renderJobList();
    // Start/stop the per-job elapsed timer
    startJobTimer(jobId, status === "applying");
  }

  // Per-job elapsed timer — ticks the M:SS counter for the active "applying" job
  let _jobTimerInterval = null;
  function startJobTimer(jobId, active) {
    if (_jobTimerInterval) { clearInterval(_jobTimerInterval); _jobTimerInterval = null; }
    if (!active) return;
    _jobTimerInterval = setInterval(() => {
      const job = scrapedJobs.find(j => j.id === jobId);
      if (!job || job.status !== "applying" || !job.startedAt) {
        clearInterval(_jobTimerInterval); _jobTimerInterval = null; return;
      }
      const el = document.getElementById(`job-timer-${jobId}`);
      if (!el) return;
      const elapsed = Math.floor((Date.now() - job.startedAt) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      el.textContent = `${m}:${s.toString().padStart(2,"0")}`;
    }, 1000);
  }

  function createFloatingUI() {
    const existing = document.getElementById("autoapply-float");
    if (existing) existing.remove();

    const container = document.createElement("div");
    container.id = "autoapply-float";
    container.innerHTML = `
      <div id="autoapply-panel" style="
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 200000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      ">
        <!-- Collapsed toggle button -->
        <button id="autoapply-toggle" style="
          background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
          color: white; border: none; border-radius: 14px;
          padding: 11px 18px; font-size: 13px; font-weight: 600;
          cursor: pointer; box-shadow: 0 4px 20px rgba(79,70,229,0.4);
          display: flex; align-items: center; gap: 8px; transition: all 0.2s;
          letter-spacing: -0.1px;
        ">
          <span style="
            background: rgba(255,255,255,0.22); border-radius: 7px;
            width: 22px; height: 22px; display: flex; align-items: center;
            justify-content: center; font-size: 12px; font-weight: 800;
          ">A</span>
          AutoApply
          <span id="autoapply-count" style="
            background: rgba(255,255,255,0.95); color: #4F46E5;
            padding: 1px 8px; border-radius: 10px;
            font-size: 11px; font-weight: 800; min-width: 18px; text-align: center;
          ">0</span>
        </button>

        <!-- Expanded panel -->
        <div id="autoapply-expanded" style="
          display: none; background: white; border-radius: 16px;
          box-shadow: 0 12px 50px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
          width: 400px; max-height: 560px; overflow: hidden;
          border: 1px solid rgba(0,0,0,0.06);
        ">
          <!-- Header -->
          <div style="
            padding: 14px 16px 12px;
            background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
            display: flex; align-items: center; justify-content: space-between;
          ">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="
                background: rgba(255,255,255,0.2); border-radius: 8px;
                width: 28px; height: 28px; display:flex; align-items:center;
                justify-content:center; font-size:13px; font-weight:800; color:white;
              ">A</div>
              <div>
                <h3 style="margin:0;font-size:13px;font-weight:700;color:white;letter-spacing:-0.1px;">AutoApply AI</h3>
                <p style="margin:1px 0 0;font-size:10px;color:rgba(255,255,255,0.7);" id="autoapply-status">Find jobs on this page to get started</p>
              </div>
            </div>
            <button id="autoapply-close" style="
              background:rgba(255,255,255,0.15); border:none; border-radius:6px;
              color:white; font-size:16px; cursor:pointer; padding:3px 7px; line-height:1;
              transition:background 0.15s;
            ">&times;</button>
          </div>

          <!-- Scan / Select all bar -->
          <div style="padding:10px 12px;border-bottom:1px solid #F0F0F0;display:flex;gap:6px;background:#FAFAFA;">
            <button id="autoapply-scan" style="
              flex:1; background:#4F46E5; color:white; border:none; border-radius:8px;
              padding:9px 12px; font-size:12px; font-weight:600; cursor:pointer;
              display:flex; align-items:center; justify-content:center; gap:5px;
              box-shadow:0 2px 8px rgba(79,70,229,0.25); transition:background 0.15s;
            ">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              Scan Page
            </button>
            <button id="autoapply-select-all" style="
              background:white; border:1px solid #E5E7EB; border-radius:8px;
              padding:9px 12px; font-size:12px; font-weight:500; cursor:pointer;
              color:#374151; transition:background 0.15s;
            ">Select All</button>
          </div>

          <!-- Job list -->
          <div id="autoapply-jobs-list" style="max-height:290px;overflow-y:auto;padding:8px;">
            <div style="
              text-align:center; padding:28px 20px; color:#9CA3AF;
            ">
              <div style="font-size:28px;margin-bottom:8px;opacity:0.4;">🔍</div>
              <p style="font-size:12px;font-weight:500;margin:0 0 4px;color:#6B7280;">No jobs loaded yet</p>
              <p style="font-size:11px;margin:0;color:#9CA3AF;">On a LinkedIn jobs page? Hit <strong style="color:#4F46E5">Scan Page</strong> above.</p>
            </div>
          </div>

          <!-- Action bar (skip / rescan during apply run) -->
          <div id="autoapply-action-bar" style="
            display:none; padding:8px 12px; border-top:1px solid #F0F0F0;
            background:#FAFAFA; gap:6px; flex-wrap:wrap;
          "></div>

          <!-- Footer: start / stop + hidden URL -->
          <div style="padding:12px;border-top:1px solid #F0F0F0;background:white;">
            <button id="autoapply-start" style="
              width:100%; background:#4F46E5; color:white; border:none; border-radius:10px;
              padding:11px; font-size:13px; font-weight:600; cursor:pointer;
              opacity:0.38; pointer-events:none; transition:all 0.2s; letter-spacing:-0.1px;
            " disabled>Select jobs above to begin</button>

            <button id="autoapply-stop" style="
              display:none; width:100%; background:#EF4444; color:white; border:none;
              border-radius:10px; padding:11px; font-size:13px; font-weight:600; cursor:pointer;
            ">⏹ Stop applying</button>

            <!-- Hidden URL field — auto-populated from storage, not shown unless empty -->
            <input id="autoapply-url" type="hidden" value="https://autoapply-ai-delta.vercel.app" />
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    setupEventListeners();
    loadSettings();
  }

  function setupEventListeners() {
    const toggle = document.getElementById("autoapply-toggle");
    const expanded = document.getElementById("autoapply-expanded");
    const close = document.getElementById("autoapply-close");
    const scan = document.getElementById("autoapply-scan");
    const selectAll = document.getElementById("autoapply-select-all");
    const start = document.getElementById("autoapply-start");
    const stop = document.getElementById("autoapply-stop");
    const urlInput = document.getElementById("autoapply-url");

    let panelOpen = false;

    toggle.addEventListener("click", () => {
      panelOpen = !panelOpen;
      toggle.style.display = panelOpen ? "none" : "flex";
      expanded.style.display = panelOpen ? "block" : "none";
    });

    close.addEventListener("click", () => {
      panelOpen = false;
      toggle.style.display = "flex";
      expanded.style.display = "none";
    });

    scan.addEventListener("click", () => {
      scrapedJobs = scrapeJobCards();
      selectedJobIds.clear();
      persistState();
      renderJobList();
      updateStatus(`Found ${scrapedJobs.length} jobs on this page`);
    });

    selectAll.addEventListener("click", () => {
      if (selectedJobIds.size === scrapedJobs.length) {
        selectedJobIds.clear();
      } else {
        scrapedJobs.forEach((j) => selectedJobIds.add(j.id));
      }
      persistState();
      renderJobList();
      updateStartButton();
    });

    start.addEventListener("click", async () => {
      // URL is hardcoded in the hidden field — no validation needed
      const url = urlInput ? urlInput.value.trim() : "https://autoapply-ai-delta.vercel.app";
      chrome.storage.local.set({ autoapplyUrl: url });

      // Show stop button, hide start
      start.style.display = "none";
      stop.style.display = "block";

      await startApplying();

      // Restore buttons
      start.style.display = "block";
      stop.style.display = "none";
      updateStartButton();
    });

    stop.addEventListener("click", () => {
      stopApplying();
      start.style.display = "block";
      stop.style.display = "none";
    });
  }

  function loadSettings() {
    // URL is hardcoded — nothing to load from storage
  }

  function getStatusIcon(status) {
    switch (status) {
      case "applying": return '<span style="color: #F59E0B;">●</span>';
      case "opened": return '<span style="color: #3B82F6;">↗</span>';
      case "applied": return '<span style="color: #10B981;">✓</span>';
      case "skipped": return '<span style="color: #9CA3AF;">○</span>';
      case "failed": return '<span style="color: #EF4444;">✗</span>';
      default: return '<span style="color: #D1D5DB;">·</span>';
    }
  }

  function renderJobList() {
    const list = document.getElementById("autoapply-jobs-list");
    if (scrapedJobs.length === 0) {
      list.innerHTML = `
        <div style="text-align:center;padding:28px 16px;">
          <div style="font-size:28px;margin-bottom:8px;">🔍</div>
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#374151;">No jobs scanned yet</p>
          <p style="margin:0;font-size:12px;color:#9CA3AF;">Hit <b>Scan Page</b> above to find jobs on this page.</p>
        </div>
      `;
      return;
    }

    const pendingCount = scrapedJobs.filter(j => j.status === "pending").length;
    const selCount = selectedJobIds.size;
    const countBar = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 6px 8px;font-size:12px;color:#555;">
        <span><b style="color:#4F46E5;font-size:13px;">${scrapedJobs.length}</b> jobs found</span>
        <span style="background:${selCount > 0 ? "#4F46E5" : "#E5E7EB"};color:${selCount > 0 ? "#fff" : "#9CA3AF"};border-radius:10px;padding:2px 10px;font-weight:700;font-size:12px;transition:background 0.2s;">
          ${selCount} selected
        </span>
      </div>`;

    list.innerHTML = countBar + scrapedJobs
      .map(
        (job) => `
      <div style="
        display: flex; align-items: center; gap: 10px; padding: 8px 10px;
        border-radius: 8px; cursor: pointer; transition: background 0.15s;
        ${selectedJobIds.has(job.id) ? "background: #EEF2FF;" : ""}
        ${job.status === "applying" ? "background: #FFF7ED;" : ""}
        ${job.status === "opened" ? "background: #EFF6FF;" : ""}
        ${job.status === "applied" ? "background: #F0FDF4;" : ""}
        ${job.status === "failed" ? "background: #FEF2F2;" : ""}
      " data-job-id="${job.id}" class="autoapply-job-item">
        ${job.status !== "pending"
          ? `<span style="font-size: 14px; flex-shrink: 0;">${getStatusIcon(job.status)}</span>`
          : `<div style="
                width: 18px; height: 18px; flex-shrink: 0; border-radius: 4px;
                border: 2px solid ${selectedJobIds.has(job.id) ? "#4F46E5" : "#C7D2FE"};
                background: ${selectedJobIds.has(job.id) ? "#4F46E5" : "#fff"};
                display: flex; align-items: center; justify-content: center;
                transition: background 0.15s, border-color 0.15s;
                ${isApplying ? "opacity: 0.5;" : ""}
              ">${selectedJobIds.has(job.id)
                ? `<svg width="11" height="9" viewBox="0 0 11 9" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4.5L3.8 7.5L10 1.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
                : ""
              }</div>`
        }
        <div style="flex: 1; min-width: 0;">
          <p style="margin: 0; font-size: 12px; font-weight: 500; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${job.title}
          </p>
          <p style="margin: 2px 0 0; font-size: 12px; font-weight: 600; color: #4F46E5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${job.company}
          </p>
          <p style="margin: 1px 0 0; font-size: 11px; font-weight: 500; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            📍 ${job.location}
            ${job.easyApply ? '<span style="color: #9CA3AF; font-size: 10px; margin-left: 4px;">(Easy Apply)</span>' : ""}
          </p>
          ${job.status === "applying" && job.statusText ? `<p style="margin:2px 0 0;font-size:10px;color:#B45309;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${job.statusText}</p>` : ""}
          ${job.status === "failed" && job.failReason ? `<p style="margin:2px 0 0;font-size:10px;color:#DC2626;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${job.failReason}">↳ ${job.failReason}</p>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;">
          ${job.status !== "pending" ? `<span style="
            font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
            ${job.status === "opened" ? "background: #DBEAFE; color: #1E40AF;" : ""}
            ${job.status === "applied" ? "background: #D1FAE5; color: #065F46;" : ""}
            ${job.status === "applying" ? "background: #FEF3C7; color: #92400E;" : ""}
            ${job.status === "failed" ? "background: #FEE2E2; color: #991B1B;" : ""}
            ${job.status === "skipped" ? "background: #F3F4F6; color: #6B7280;" : ""}
          ">${job.status}</span>` : ""}
          ${job.status === "applying" ? `<span id="job-timer-${job.id}" style="font-size:10px;font-weight:700;color:#92400E;font-variant-numeric:tabular-nums;">0:00</span>` : ""}
          ${job.status === "opened" && job.atsTabId ? `<button class="aa-continue-btn" data-tab-id="${job.atsTabId}" style="
            font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;
            background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE;cursor:pointer;margin-top:2px;
          ">↗ Continue</button>` : ""}
        </div>
      </div>
    `
      )
      .join("");

    // Wire "↗ Continue" buttons — work regardless of isApplying state
    list.querySelectorAll(".aa-continue-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tabId = parseInt(btn.getAttribute("data-tab-id"), 10);
        if (tabId) chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId });
      });
    });

    if (!isApplying) {
      list.querySelectorAll(".autoapply-job-item").forEach((item) => {
        item.addEventListener("click", () => {
          const id = item.getAttribute("data-job-id");
          // Don't allow toggling already-processed jobs
          const job = scrapedJobs.find((j) => j.id === id);
          if (job && job.status !== "pending") return;
          if (selectedJobIds.has(id)) selectedJobIds.delete(id);
          else selectedJobIds.add(id);
          persistState();
          renderJobList();
          updateStartButton();
        });
      });
    }

    updateStartButton();
    updateActionBar();
  }

  function updateStartButton() {
    const start = document.getElementById("autoapply-start");
    const count = document.getElementById("autoapply-count");
    if (start) {
      const n = selectedJobIds.size;
      start.textContent = n === 0 ? "Select jobs above to begin" : `Apply to ${n} job${n === 1 ? "" : "s"} →`;
      start.disabled = n === 0;
      start.style.opacity = n === 0 ? "0.38" : "1";
      start.style.pointerEvents = n === 0 ? "none" : "auto";
      start.style.cursor = n === 0 ? "default" : "pointer";
    }
    if (count) count.textContent = `${scrapedJobs.length}`;
  }

  // Initialize
  createFloatingUI();

  // On every page load, clear any stale batch-progress state (the in-memory
  // apply loop is gone after a reload, so an active:true flag is always stale).
  // Then restore previously scanned jobs + selections so the user doesn't lose
  // their work when they navigate back to the LinkedIn jobs page.
  chrome.storage.local.get(["_aa_batchProgress", "_aa_scrapedJobs", "_aa_selectedIds"], (result) => {
    const bp = result._aa_batchProgress;
    if (bp && bp.active) {
      try { AALog && AALog.state("batch.staleCleared", { reason: "page_reload", prior: bp }); } catch(_){}
      chrome.storage.local.set({ _aa_batchProgress: { active: false } });
    }

    // Restore scanned jobs + selections from the previous session on this page
    if (result._aa_scrapedJobs && Array.isArray(result._aa_scrapedJobs) && result._aa_scrapedJobs.length > 0) {
      scrapedJobs = result._aa_scrapedJobs;
      selectedJobIds = new Set(result._aa_selectedIds || []);
      console.log(`AutoApply: Restored ${scrapedJobs.length} jobs from storage (${selectedJobIds.size} selected)`);
      renderJobList();
      updateStartButton();
    }
  });
})();
