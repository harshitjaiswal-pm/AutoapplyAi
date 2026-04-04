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
  if (window.__autoapply_injected) return;
  window.__autoapply_injected = true;

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
   * Scrape all visible job cards using dismiss button aria-labels as anchors.
   */
  function scrapeJobCards() {
    const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"]');
    const jobs = [];

    dismissBtns.forEach((btn, index) => {
      try {
        const ariaLabel = btn.getAttribute("aria-label") || "";
        const ariaTitle = ariaLabel.replace(/^Dismiss\s+/i, "").replace(/\s+job$/i, "").trim();
        if (!ariaTitle) return;

        let card = btn;
        for (let i = 0; i < 6; i++) {
          if (card.parentElement) card = card.parentElement;
          if (card.tagName === "LI" || card.getAttribute("data-occludable-job-id")) break;
        }

        const text = card?.innerText?.trim() || "";
        if (!text || text.length < 10) return;

        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        const titleLower = ariaTitle.toLowerCase();
        const noiseWords = ["easy apply", "promoted", "verified", "actively recruiting", "viewed", "applied", "new", "dismiss"];

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

        jobs.push({
          id: `li_${Date.now()}_${index}`,
          index, // original dismiss button index for clicking
          title: ariaTitle.replace(/\s*\(Verified job\)/i, ""),
          company,
          location,
          easyApply,
          selected: false,
          status: "pending", // pending | applying | applied | skipped | failed
        });
      } catch (e) {
        console.warn("AutoApply: Failed to parse job card", e);
      }
    });

    return jobs;
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
  async function clickJobCard(dismissIndex, jobTitle) {
    const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"]');

    // Strategy 1: Always try the original index first — most reliable for duplicate titles
    let btn = dismissBtns[dismissIndex];

    // Strategy 2: If index doesn't exist (scrolled away), fall back to title search
    if (!btn && jobTitle) {
      const titleLower = jobTitle.toLowerCase();
      for (const candidate of dismissBtns) {
        const ariaLabel = (candidate.getAttribute("aria-label") || "").toLowerCase();
        if (ariaLabel.includes(titleLower.substring(0, 20))) {
          btn = candidate;
          break;
        }
      }
    }

    if (!btn) {
      console.warn("AutoApply: No dismiss button found at index", dismissIndex, "for", jobTitle);
      return false;
    }

    // Click the card's <li> container, not the dismiss button itself
    let card = btn;
    for (let i = 0; i < 6; i++) {
      if (card.parentElement) card = card.parentElement;
      if (card.tagName === "LI" || card.getAttribute("data-occludable-job-id")) break;
    }

    if (card) {
      card.click();
      await new Promise((r) => setTimeout(r, 2500));
      return true;
    }
    return false;
  }

  /**
   * Find and click the Apply button in the detail panel.
   * Returns the type: "external" | "easy_apply" | null
   */
  async function clickApplyButton() {
    // Look for apply buttons in the detail panel (right side)
    const allButtons = document.querySelectorAll("button, a");

    let bestApplyBtn = null;
    let bestType = null;

    for (const btn of allButtons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      const href = (btn.getAttribute("href") || "").toLowerCase();

      // Skip if it's inside the job list sidebar (has dismiss buttons nearby)
      if (btn.closest && btn.closest('[class*="jobs-search"]')) continue;
      // Skip tiny or hidden buttons
      if (btn.offsetWidth < 30 || btn.offsetHeight < 15) continue;
      // Skip "Save" / "Share" / "Report" buttons
      if (text.includes("save") || text.includes("share") || text.includes("report")) continue;

      // Detect Easy Apply first (check both text and aria-label)
      if (text.includes("easy apply") || ariaLabel.includes("easy apply")) {
        bestApplyBtn = btn;
        bestType = "easy_apply";
        continue; // Keep looking for an external Apply button which takes priority
      }

      // External Apply button — usually has an external link icon or opens new tab
      if ((text === "apply" || text === "apply now" ||
           ariaLabel.includes("apply to") || ariaLabel.includes("apply for")) &&
          !text.includes("easy")) {
        // Prefer buttons that are links (external apply)
        if (btn.tagName === "A" || href || btn.querySelector("svg") || ariaLabel.includes("opens")) {
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
    updateJobStatus(job.id, "applying");
    updateStatus(`Applying: ${job.title} at ${job.company}...`);

    try {
      // Step 1: Click the job card to load detail panel
      updateStatus(`Loading: ${job.title}...`);
      const clicked = await clickJobCard(job.index, job.title);
      if (!clicked) {
        console.warn("AutoApply: Could not click job card for", job.title, "at index", job.index);
        updateJobStatus(job.id, "failed");
        return { success: false, reason: "Could not click job card" };
      }

      // Step 2: Scroll the detail panel to load the full JD
      updateStatus(`Scrolling to load JD: ${job.title}...`);
      await scrollDetailPanel();
      // Extra wait for content to render
      await new Promise((r) => setTimeout(r, 1000));

      // Step 3: Scrape the JD from the detail panel
      updateStatus(`Scraping JD: ${job.title}...`);
      let jobDescription = scrapeJobDescription();
      if (!jobDescription || jobDescription.length < 50) {
        // Try scrolling more and retrying
        await scrollDetailPanel();
        await new Promise((r) => setTimeout(r, 1000));
        jobDescription = scrapeJobDescription();
        if (!jobDescription || jobDescription.length < 50) {
          updateJobStatus(job.id, "failed");
          return { success: false, reason: "Could not scrape job description" };
        }
      }

      // Step 3: Send job data to background for processing BEFORE clicking Apply
      // Background will store it and the ATS content script will pick it up
      const jobData = {
        jobTitle: job.title,
        company: job.company,
        location: job.location,
        jobDescription,
        easyApply: job.easyApply,
        source: "linkedin",
      };

      // Store in chrome.storage so ATS scripts can access it
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "PREPARE_APPLICATION",
          job: jobData,
        }, resolve);
      });

      // Step 4: Click the Apply button
      updateStatus(`Clicking Apply: ${job.title}...`);
      const applyType = await clickApplyButton();

      if (applyType === "external") {
        // External site opened in new tab — ATS content script will handle it
        updateJobStatus(job.id, "applied");
        appliedCount++;
        updateStatus(`Applied externally: ${job.title}. Waiting for tab to open...`);
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

  /**
   * Run the auto-apply loop for all selected jobs.
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

      // Show prominent progress overlay
      showProgressOverlay(jobNumber, selectedJobs.length, job);
      updateStatus(`Processing ${jobNumber}/${selectedJobs.length}: ${job.title}`);

      // Store batch progress so background.js + ATS tabs can read it
      await new Promise((resolve) => {
        chrome.storage.local.set({
          _aa_currentJobNumber: jobNumber,
          _aa_totalJobs: selectedJobs.length,
          _aa_batchProgress: {
            current: jobNumber,
            total: selectedJobs.length,
            jobTitle: job.title,
            company: job.company,
            location: job.location,
            applied: appliedCount,
            skipped: skippedCount,
            active: true,
          },
        }, resolve);
      });

      await processJob(job);

      // Brief pause between jobs to avoid rate limiting
      if (i < selectedJobs.length - 1) {
        showProgressOverlay(jobNumber, selectedJobs.length, job);
        updateStatus(`Waiting before next job... (${jobNumber}/${selectedJobs.length} done)`);
        await new Promise((r) => setTimeout(r, 2000));
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

  function updateJobStatus(jobId, status) {
    const job = scrapedJobs.find((j) => j.id === jobId);
    if (job) job.status = status;
    // Persist job statuses so UI survives tab switches / re-injection
    persistState();
    renderJobList();
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
        </div>
        ${job.status !== "pending" ? `<span style="
          font-size: 10px; font-weight: 600; flex-shrink: 0; padding: 2px 6px; border-radius: 4px;
          ${job.status === "applied" ? "background: #D1FAE5; color: #065F46;" : ""}
          ${job.status === "applying" ? "background: #FEF3C7; color: #92400E;" : ""}
          ${job.status === "failed" ? "background: #FEE2E2; color: #991B1B;" : ""}
          ${job.status === "skipped" ? "background: #F3F4F6; color: #6B7280;" : ""}
        ">${job.status}</span>` : ""}
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

  // Restore previously scanned jobs from chrome.storage (survives SPA navigation & re-injection)
  restoreState().then(() => {
    if (scrapedJobs.length > 0) {
      renderJobList();
      updateStartButton();

      // Check if batch is still active — auto-open panel and show progress overlay
      chrome.storage.local.get(["_aa_batchProgress"], (result) => {
        const bp = result._aa_batchProgress;
        if (bp && bp.active) {
          // Auto-expand the panel so user sees status
          const toggle = document.getElementById("autoapply-toggle");
          const expanded = document.getElementById("autoapply-expanded");
          if (toggle && expanded) {
            toggle.style.display = "none";
            expanded.style.display = "block";
          }
          showProgressOverlay(bp.current, bp.total, { title: bp.jobTitle, company: bp.company, location: bp.location });
          updateStatus(`In progress: Job ${bp.current}/${bp.total} — ${bp.jobTitle}`);
        } else {
          updateStatus(`Restored ${scrapedJobs.length} jobs from previous scan`);
        }
      });
    }
  });
})();
