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
    // --- Strategy A: data-occludable-job-id (classic search) ---
    const cardItems = document.querySelectorAll("li[data-occludable-job-id]");
    if (cardItems.length > 0) {
      console.log(`AutoApply: Using Strategy A (data-occludable-job-id), found ${cardItems.length} cards`);
      return scrapeStrategyA(cardItems);
    }

    // --- Strategy B: dismiss button aria-labels (AI-powered search-results) ---
    const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"][aria-label$=" job"]');
    if (dismissBtns.length > 0) {
      console.log(`AutoApply: Using Strategy B (dismiss buttons), found ${dismissBtns.length} cards`);
      return scrapeStrategyB(dismissBtns);
    }

    console.warn("AutoApply: No job cards found with any strategy");
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
   * Scrape JD from the right-side detail panel after clicking a job card.
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
      return false;
    }

    // Click the card to load job details in the right panel
    card.click();
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  }

  /**
   * Find and click the Apply button in the detail panel.
   * Returns the type: "external" | "easy_apply" | null
   */
  async function clickApplyButton() {
    // Check if already applied to this job
    const detailPanel = document.querySelector('.jobs-search__job-details, .job-details-jobs-unified-top-card, [class*="job-details"]');
    const detailText = (detailPanel?.innerText || document.body.innerText).toLowerCase();
    if (detailText.includes("applied") && (detailText.includes("see application") || detailText.includes("ago"))) {
      // Check more carefully — look for "Applied X ago" pattern near the top
      const appliedMatch = detailText.match(/applied\s+\d+\s+(day|week|month|hour|minute)/);
      if (appliedMatch) {
        console.log("AutoApply: Already applied to this job — skipping");
        return "already_applied";
      }
    }

    // Look for apply buttons in the detail panel (right side)
    const allButtons = document.querySelectorAll("button, a");

    let bestApplyBtn = null;
    let bestType = null;

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
        continue; // Keep looking for an external Apply button which takes priority
      }

      // External Apply button — usually has an external link icon or opens new tab
      if ((text === "apply" || text === "apply now" ||
           ariaLabel.includes("apply to") || ariaLabel.includes("apply for")) &&
          !text.includes("easy")) {
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

    if (!bestApplyBtn) return null;

    if (bestType === "easy_apply") {
      // Don't click Easy Apply — just report it
      return "easy_apply";
    }

    // External apply — click it
    console.log("AutoApply: Clicking external Apply button: " + (bestApplyBtn.getAttribute("aria-label") || bestApplyBtn.textContent.trim()));
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
      } else {
        updateJobStatus(job.id, "failed");
        return { success: false, reason: "No Apply button found" };
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

        <div style="padding: 16px 20px; display: flex; gap: 10px;">
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
   * Returns: "apply" | "skip" | "stop"
   */
  function showConfirmation(jobNumber, totalJobs, job, tailoredResult, jobDescription) {
    return new Promise((resolve) => {
      const modal = createConfirmationModal();
      modal.style.display = "flex";

      document.getElementById("confirm-step").textContent = `Job ${jobNumber}/${totalJobs}`;
      document.getElementById("confirm-title").textContent = job.title;
      document.getElementById("confirm-company").textContent = `${job.company} — ${job.location}`;

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
      };

      const applyBtn = document.getElementById("confirm-apply");
      const skipBtn = document.getElementById("confirm-skip");
      const stopBtn = document.getElementById("confirm-stop");

      const onApply = () => { cleanup(); resolve("apply"); };
      const onSkip = () => { cleanup(); resolve("skip"); };
      const onStop = () => { cleanup(); resolve("stop"); };

      applyBtn.addEventListener("click", onApply);
      skipBtn.addEventListener("click", onSkip);
      stopBtn.addEventListener("click", onStop);
    });
  }

  /**
   * Run the auto-apply loop for all selected jobs.
   * Shows a confirmation modal for each job so the user stays in the loop.
   */
  async function startApplying() {
    const selectedJobs = scrapedJobs.filter((j) => selectedJobIds.has(j.id));
    if (selectedJobs.length === 0) return;

    isApplying = true;
    appliedCount = 0;
    skippedCount = 0;
    currentJobIndex = 0;
    renderJobList();

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

      currentJobIndex = i;
      const job = selectedJobs[i];
      const jobNumber = i + 1;

      // Step 1: Click job card to load JD
      showProgressOverlay(jobNumber, selectedJobs.length, job);
      updateJobStatus(job.id, "applying", "Loading job details...");

      const clicked = await clickJobCard(job);
      if (!clicked) {
        updateJobStatus(job.id, "failed");
        continue;
      }

      updateJobStatus(job.id, "applying", "Reading job description...");
      await scrollDetailPanel();
      await new Promise((r) => setTimeout(r, 800));
      const jobDescription = scrapeJobDescription();

      // Step 2: Tailor the resume in background (non-blocking preview)
      updateJobStatus(job.id, "applying", "Scanning job description...");
      let tailoredResult = null;
      const jobData = {
        jobTitle: job.title, company: job.company,
        location: job.location, jobDescription,
        easyApply: job.easyApply, source: "linkedin",
      };

      // Start tailoring asynchronously — we'll show partial results in the modal
      const tailorPromise = new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "TAILOR_AND_FILL", job: jobData }, resolve);
      });

      // Step 3: Show confirmation modal — user decides per-job
      updateJobStatus(job.id, "applying", "Tailoring resume...");
      updateStatus(`Review job ${jobNumber}/${selectedJobs.length}: ${job.title}`);

      // Wait for tailoring to complete before showing confirmation
      try {
        const result = await tailorPromise;
        if (result && !result.error) tailoredResult = result.tailoredResult || result;
      } catch (err) {
        console.warn("AutoApply: Tailoring error for", job.title, err);
      }

      const decision = await showConfirmation(jobNumber, selectedJobs.length, job, tailoredResult, jobDescription);

      if (decision === "stop") {
        stopApplying();
        break;
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
            jobTitle: job.title, company: job.company, location: job.location,
            applied: appliedCount, skipped: skippedCount, active: true,
          },
        }, resolve);
      });

      // Store pending application for ATS script
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "PREPARE_APPLICATION", job: jobData }, resolve);
      });

      // Step 4: Click Apply button
      showProgressOverlay(jobNumber, selectedJobs.length, job);
      updateJobStatus(job.id, "applying", "Opening application...");
      const applyType = await clickApplyButton();

      if (applyType === "external") {
        updateJobStatus(job.id, "opened");
        appliedCount++;
        updateStatus(`Tab opened: ${job.title}. ATS auto-filling...`);
        await new Promise((r) => setTimeout(r, 3000));
      } else if (applyType === "easy_apply") {
        updateJobStatus(job.id, "skipped");
        skippedCount++;
        updateStatus(`Skipped (Easy Apply): ${job.title}`);
      } else if (applyType === "already_applied") {
        updateJobStatus(job.id, "skipped");
        skippedCount++;
        updateStatus(`Already applied: ${job.title}`);
      } else {
        updateJobStatus(job.id, "failed");
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
    hideProgressOverlay();
    chrome.storage.local.set({ _aa_batchProgress: { active: false } });
    updateStatus("Stopped by user.", "error");
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
      if (status !== "applying") { job.startedAt = null; job.statusText = ""; }
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
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      ">
        <button id="autoapply-toggle" style="
          background: #4F46E5;
          color: white;
          border: none;
          border-radius: 12px;
          padding: 12px 20px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          box-shadow: 0 4px 20px rgba(79, 70, 229, 0.3);
          display: flex;
          align-items: center;
          gap: 8px;
          transition: all 0.2s;
        ">
          <span style="font-size: 16px;">A</span>
          AutoApply
          <span id="autoapply-count" style="
            background: rgba(255,255,255,0.2);
            padding: 2px 8px;
            border-radius: 8px;
            font-size: 11px;
          ">0</span>
        </button>

        <div id="autoapply-expanded" style="
          display: none;
          background: white;
          border-radius: 16px;
          box-shadow: 0 8px 40px rgba(0,0,0,0.15);
          width: 400px;
          max-height: 550px;
          overflow: hidden;
        ">
          <div style="
            padding: 16px;
            border-bottom: 1px solid #E5E5E5;
            display: flex;
            align-items: center;
            justify-content: space-between;
          ">
            <div>
              <h3 style="margin: 0; font-size: 14px; font-weight: 600; color: #111;">AutoApply AI</h3>
              <p style="margin: 2px 0 0; font-size: 11px; color: #999;" id="autoapply-status">Scan jobs to get started</p>
            </div>
            <button id="autoapply-close" style="
              background: none; border: none; font-size: 18px; cursor: pointer; color: #999; padding: 4px;
            ">&times;</button>
          </div>

          <div style="padding: 12px 16px; border-bottom: 1px solid #E5E5E5; display: flex; gap: 8px;">
            <button id="autoapply-scan" style="
              flex: 1; background: #F5F5F5; border: 1px solid #E5E5E5; border-radius: 8px;
              padding: 8px; font-size: 12px; font-weight: 500; cursor: pointer; color: #333;
            ">Scan Page</button>
            <button id="autoapply-select-all" style="
              background: #F5F5F5; border: 1px solid #E5E5E5; border-radius: 8px;
              padding: 8px 12px; font-size: 12px; font-weight: 500; cursor: pointer; color: #333;
            ">Select All</button>
          </div>

          <div id="autoapply-jobs-list" style="
            max-height: 300px; overflow-y: auto; padding: 8px;
          ">
            <p style="text-align: center; color: #CCC; font-size: 12px; padding: 20px;">
              Click "Scan Page" to find jobs
            </p>
          </div>

          <div style="padding: 12px 16px; border-top: 1px solid #E5E5E5;">
            <button id="autoapply-start" style="
              width: 100%; background: #4F46E5; color: white; border: none; border-radius: 8px;
              padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer; opacity: 0.5;
            " disabled>Start Applying (0)</button>

            <button id="autoapply-stop" style="
              display: none; width: 100%; background: #EF4444; color: white; border: none;
              border-radius: 8px; padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer;
            ">Stop</button>

            <div style="margin-top: 8px; display: flex; gap: 8px;">
              <input id="autoapply-url" type="text" placeholder="AutoApply URL" style="
                flex: 1; padding: 6px 10px; font-size: 11px; border: 1px solid #E5E5E5;
                border-radius: 6px; color: #666;
              " />
            </div>
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
      const url = urlInput.value.trim();
      if (!url) {
        alert("Please enter your AutoApply AI URL (e.g., https://your-app.vercel.app)");
        return;
      }
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

    urlInput.addEventListener("change", () => {
      chrome.storage.local.set({ autoapplyUrl: urlInput.value.trim() });
    });
  }

  function loadSettings() {
    chrome.storage.local.get(["autoapplyUrl"], (result) => {
      if (result.autoapplyUrl) {
        document.getElementById("autoapply-url").value = result.autoapplyUrl;
      }
    });
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
        <p style="text-align: center; color: #CCC; font-size: 12px; padding: 20px;">
          No jobs found. Make sure you're on a LinkedIn job search page.
        </p>
      `;
      return;
    }

    list.innerHTML = scrapedJobs
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
        ${(isApplying || job.status !== "pending")
          ? `<span style="font-size: 14px; flex-shrink: 0;">${getStatusIcon(job.status)}</span>`
          : `<input type="checkbox" ${selectedJobIds.has(job.id) ? "checked" : ""} style="
              width: 16px; height: 16px; accent-color: #4F46E5; cursor: pointer; flex-shrink: 0;
            " />`
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
        </div>
      </div>
    `
      )
      .join("");

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
  }

  function updateStartButton() {
    const start = document.getElementById("autoapply-start");
    const count = document.getElementById("autoapply-count");
    if (start) {
      start.textContent = `Start Applying (${selectedJobIds.size})`;
      start.disabled = selectedJobIds.size === 0;
      start.style.opacity = selectedJobIds.size === 0 ? "0.5" : "1";
    }
    if (count) count.textContent = `${scrapedJobs.length}`;
  }

  // Initialize
  createFloatingUI();

  // Only restore previous state if a batch is actively in progress.
  // On a fresh page load or Scan Page click, always start clean.
  chrome.storage.local.get(["_aa_batchProgress", "_aa_scrapedJobs", "_aa_selectedIds"], (result) => {
    const bp = result._aa_batchProgress;
    const batchActive = bp && bp.active;

    if (batchActive) {
      // Batch is running — restore jobs so the UI stays consistent mid-apply
      if (result._aa_scrapedJobs && Array.isArray(result._aa_scrapedJobs)) {
        scrapedJobs = result._aa_scrapedJobs;
        selectedJobIds = new Set(result._aa_selectedIds || []);
      }
      renderJobList();
      updateStartButton();

      // Auto-expand the panel and show progress overlay
      const toggle = document.getElementById("autoapply-toggle");
      const expanded = document.getElementById("autoapply-expanded");
      if (toggle && expanded) {
        toggle.style.display = "none";
        expanded.style.display = "block";
      }
      showProgressOverlay(bp.current, bp.total, { title: bp.jobTitle, company: bp.company, location: bp.location });
      updateStatus(`In progress: Job ${bp.current}/${bp.total} — ${bp.jobTitle}`);
    } else {
      // No active batch — start fresh. Clear any stale stored jobs.
      chrome.storage.local.remove(["_aa_scrapedJobs", "_aa_selectedIds"]);
    }
  });
})();
