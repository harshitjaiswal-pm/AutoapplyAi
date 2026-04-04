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
   */
  async function clickJobCard(dismissIndex) {
    const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"]');
    const btn = dismissBtns[dismissIndex];
    if (!btn) return false;

    // Click the card area, not the dismiss button
    const card = btn.parentElement?.parentElement || btn.parentElement;
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
    // Look for apply buttons in the detail panel
    const allButtons = document.querySelectorAll("button, a");

    for (const btn of allButtons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();

      // Skip if it's inside the job list sidebar (has dismiss buttons nearby)
      if (btn.closest && btn.closest('[class*="jobs-search"]')) continue;

      // External Apply button (usually an <a> link or button that opens new tab)
      if (text === "apply" || ariaLabel.includes("apply to") ||
          (text.includes("apply") && !text.includes("easy"))) {

        // Check if it's Easy Apply
        if (text.includes("easy apply") || ariaLabel.includes("easy apply")) {
          return "easy_apply";
        }

        // External apply — click it
        btn.click();
        await new Promise((r) => setTimeout(r, 1500));
        return "external";
      }
    }

    return null;
  }

  /* ─────────────────────── AUTO-APPLY ENGINE ─────────────────────── */

  /**
   * Process a single job: click card → scrape JD → click Apply → notify background
   */
  async function processJob(job) {
    updateJobStatus(job.id, "applying");
    updateStatus(`Applying: ${job.title} at ${job.company}...`);

    try {
      // Step 1: Click the job card to load detail panel
      updateStatus(`Loading: ${job.title}...`);
      const clicked = await clickJobCard(job.index);
      if (!clicked) {
        updateJobStatus(job.id, "failed");
        return { success: false, reason: "Could not click job card" };
      }

      // Step 2: Scrape the JD from the detail panel
      updateStatus(`Scraping JD: ${job.title}...`);
      const jobDescription = scrapeJobDescription();
      if (!jobDescription || jobDescription.length < 50) {
        updateJobStatus(job.id, "failed");
        return { success: false, reason: "Could not scrape job description" };
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
        updateStatus(`Applied externally: ${job.title}. Waiting for form fill...`);
        // Give time for the external tab to open and process
        await new Promise((r) => setTimeout(r, 3000));
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
      updateStatus("No resume found. Upload your resume on the AutoApply pipeline page first.");
      isApplying = false;
      return;
    }

    for (let i = 0; i < selectedJobs.length; i++) {
      if (!isApplying) break; // User stopped

      currentJobIndex = i;
      const job = selectedJobs[i];
      updateStatus(`Processing ${i + 1}/${selectedJobs.length}: ${job.title}`);

      await processJob(job);

      // Brief pause between jobs to avoid rate limiting
      if (i < selectedJobs.length - 1) {
        updateStatus(`Waiting before next job... (${i + 1}/${selectedJobs.length} done)`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    isApplying = false;
    updateStatus(`Done! ${appliedCount} applied, ${skippedCount} skipped.`);
    renderJobList();
  }

  function stopApplying() {
    isApplying = false;
    updateStatus("Stopped by user.");
  }

  /* ─────────────────────── UI ─────────────────────── */

  function updateStatus(msg) {
    const el = document.getElementById("autoapply-status");
    if (el) el.textContent = msg;
  }

  function updateJobStatus(jobId, status) {
    const job = scrapedJobs.find((j) => j.id === jobId);
    if (job) job.status = status;
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
      renderJobList();
      updateStatus(`Found ${scrapedJobs.length} jobs on this page`);
    });

    selectAll.addEventListener("click", () => {
      if (selectedJobIds.size === scrapedJobs.length) {
        selectedJobIds.clear();
      } else {
        scrapedJobs.forEach((j) => selectedJobIds.add(j.id));
      }
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
        ${isApplying
          ? `<span style="font-size: 14px; flex-shrink: 0;">${getStatusIcon(job.status)}</span>`
          : `<input type="checkbox" ${selectedJobIds.has(job.id) ? "checked" : ""} style="
              width: 16px; height: 16px; accent-color: #4F46E5; cursor: pointer; flex-shrink: 0;
            " />`
        }
        <div style="flex: 1; min-width: 0;">
          <p style="margin: 0; font-size: 12px; font-weight: 500; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${job.title}
          </p>
          <p style="margin: 2px 0 0; font-size: 11px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${job.company} · ${job.location}
            ${job.easyApply ? '<span style="color: #9CA3AF; font-size: 10px; margin-left: 4px;">(Easy Apply)</span>' : ""}
          </p>
        </div>
        <span style="font-size: 10px; color: #999; flex-shrink: 0;">
          ${job.status !== "pending" ? job.status : ""}
        </span>
      </div>
    `
      )
      .join("");

    if (!isApplying) {
      list.querySelectorAll(".autoapply-job-item").forEach((item) => {
        item.addEventListener("click", () => {
          const id = item.getAttribute("data-job-id");
          if (selectedJobIds.has(id)) selectedJobIds.delete(id);
          else selectedJobIds.add(id);
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
})();
