/**
 * CONTENT SCRIPT — Runs on LinkedIn job search pages.
 *
 * LinkedIn uses obfuscated/hashed class names that change frequently,
 * so we use stable anchors: dismiss buttons with aria-labels, innerText parsing,
 * and structural patterns rather than CSS class selectors.
 */

(() => {
  if (window.__autoapply_injected) return;
  window.__autoapply_injected = true;

  // State
  let scrapedJobs = [];
  let selectedJobIds = new Set();

  /**
   * Scrape all visible job cards from the search results.
   *
   * Strategy: LinkedIn's dismiss buttons have aria-label="Dismiss {Job Title} job"
   * which is a stable, semantic anchor. We walk up the DOM from each dismiss button
   * to find the card container, then parse innerText lines for title/company/location.
   */
  function scrapeJobCards() {
    const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"]');
    const jobs = [];

    dismissBtns.forEach((btn, index) => {
      try {
        // Walk up to the card container (parent of parent typically has the full card text)
        let card = btn.parentElement?.parentElement;
        if (!card) card = btn.parentElement;

        const text = card?.innerText?.trim() || "";
        if (!text || text.length < 10) return;

        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) return;

        // Line 0: Job title
        // Line 1: Company name
        // Line 2: Location
        const title = lines[0] || "";
        const company = (lines[1] || "").replace(/\s*\(Verified job\)/i, "");
        const location = lines[2] || "";

        // Check for Easy Apply in the full card text (may be further up the DOM)
        const parentText = card.parentElement?.innerText || text;
        const easyApply = parentText.toLowerCase().includes("easy apply");

        // Extract job title from aria-label as backup (more reliable)
        const ariaLabel = btn.getAttribute("aria-label") || "";
        const ariaTitle = ariaLabel
          .replace(/^Dismiss\s+/i, "")
          .replace(/\s+job$/i, "")
          .trim();

        // Use aria-label title if our parsed title seems wrong
        const finalTitle = title.length > 5 ? title : ariaTitle;

        // Try to find a job URL - click handler on the card usually navigates
        // LinkedIn uses data attributes or URL params for job IDs
        const currentUrl = window.location.href;
        const jobIdMatch = currentUrl.match(/currentJobId=(\d+)/);

        if (finalTitle) {
          jobs.push({
            id: `li_${Date.now()}_${index}`,
            title: finalTitle.replace(/\s*\(Verified job\)/i, ""),
            company,
            location,
            url: "", // Will be populated when clicking through
            easyApply,
            selected: false,
          });
        }
      } catch (e) {
        console.warn("AutoApply: Failed to parse job card", e);
      }
    });

    return jobs;
  }

  /**
   * Scrape the full job description from the right-side detail panel.
   */
  function scrapeJobDescription() {
    // Try multiple possible containers for the job description
    const selectors = [
      '[class*="jobs-description"]',
      '[class*="job-details"]',
      'article',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    // Fallback: find the right panel and get its text
    const mainContent = document.querySelector('main');
    if (mainContent) {
      // The right panel is usually the second major div
      const sections = mainContent.querySelectorAll(':scope > div > div');
      for (const section of sections) {
        const text = section.innerText?.trim();
        if (text && text.length > 200 && text.includes("About the job")) {
          return text;
        }
      }
    }

    return "";
  }

  /**
   * Click on a job card to load its full description in the detail panel.
   */
  async function clickJobCard(index) {
    const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"]');
    const btn = dismissBtns[index];
    if (!btn) return false;

    // Click the card area (not the dismiss button itself!)
    const card = btn.parentElement?.parentElement || btn.parentElement;
    if (card) {
      card.click();
      // Wait for detail panel to load
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    }
    return false;
  }

  /**
   * Create the floating AutoApply UI on the page.
   */
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
          width: 380px;
          max-height: 500px;
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
              background: none;
              border: none;
              font-size: 18px;
              cursor: pointer;
              color: #999;
              padding: 4px;
            ">&times;</button>
          </div>

          <div style="padding: 12px 16px; border-bottom: 1px solid #E5E5E5; display: flex; gap: 8px;">
            <button id="autoapply-scan" style="
              flex: 1;
              background: #F5F5F5;
              border: 1px solid #E5E5E5;
              border-radius: 8px;
              padding: 8px;
              font-size: 12px;
              font-weight: 500;
              cursor: pointer;
              color: #333;
            ">Scan Page</button>
            <button id="autoapply-select-all" style="
              background: #F5F5F5;
              border: 1px solid #E5E5E5;
              border-radius: 8px;
              padding: 8px 12px;
              font-size: 12px;
              font-weight: 500;
              cursor: pointer;
              color: #333;
            ">Select All</button>
          </div>

          <div id="autoapply-jobs-list" style="
            max-height: 300px;
            overflow-y: auto;
            padding: 8px;
          ">
            <p style="text-align: center; color: #CCC; font-size: 12px; padding: 20px;">
              Click "Scan Page" to find jobs
            </p>
          </div>

          <div style="padding: 12px 16px; border-top: 1px solid #E5E5E5;">
            <button id="autoapply-send" style="
              width: 100%;
              background: #4F46E5;
              color: white;
              border: none;
              border-radius: 8px;
              padding: 10px;
              font-size: 13px;
              font-weight: 600;
              cursor: pointer;
              opacity: 0.5;
            " disabled>Send to AutoApply (0)</button>

            <div style="margin-top: 8px; display: flex; gap: 8px;">
              <input id="autoapply-url" type="text" placeholder="AutoApply URL" style="
                flex: 1;
                padding: 6px 10px;
                font-size: 11px;
                border: 1px solid #E5E5E5;
                border-radius: 6px;
                color: #666;
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
    const send = document.getElementById("autoapply-send");
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
      document.getElementById("autoapply-status").textContent =
        `Found ${scrapedJobs.length} jobs on this page`;
    });

    selectAll.addEventListener("click", () => {
      if (selectedJobIds.size === scrapedJobs.length) {
        selectedJobIds.clear();
      } else {
        scrapedJobs.forEach((j) => selectedJobIds.add(j.id));
      }
      renderJobList();
      updateSendButton();
    });

    send.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) {
        alert("Please enter your AutoApply AI URL");
        return;
      }

      chrome.storage.local.set({ autoapplyUrl: url });

      const selectedJobs = scrapedJobs.filter((j) => selectedJobIds.has(j.id));
      if (selectedJobs.length === 0) return;

      send.textContent = "Scraping descriptions...";
      send.disabled = true;

      // For each selected job, click the card to load its description
      const jobsWithDescriptions = [];
      const dismissBtns = document.querySelectorAll('button[aria-label*="Dismiss"]');

      for (const job of selectedJobs) {
        const jobIndex = scrapedJobs.indexOf(job);
        let description = "";

        try {
          // Click the card to load description
          const card = dismissBtns[jobIndex]?.parentElement?.parentElement || dismissBtns[jobIndex]?.parentElement;
          if (card) {
            card.click();
            await new Promise((r) => setTimeout(r, 2000));
            description = scrapeJobDescription();
          }
        } catch (e) {
          console.warn("AutoApply: Failed to scrape description for", job.title, e);
        }

        jobsWithDescriptions.push({
          ...job,
          description: description || `${job.title} at ${job.company} - ${job.location}`,
        });

        send.textContent = `Scraping... (${jobsWithDescriptions.length}/${selectedJobs.length})`;
      }

      send.textContent = "Sending to AutoApply...";

      try {
        const payload = jobsWithDescriptions.map((j) => ({
          jobTitle: j.title,
          company: j.company,
          location: j.location,
          jobUrl: j.url || window.location.href,
          jobDescription: j.description,
          easyApply: j.easyApply,
          source: "linkedin",
        }));

        // Send via background script — it opens the tab and injects data into localStorage
        chrome.runtime.sendMessage({
          type: "SEND_JOBS_TO_PIPELINE",
          jobs: payload,
          url: url,
        });

        send.textContent = `Sent ${selectedJobs.length} jobs!`;
        setTimeout(() => {
          send.textContent = `Send to AutoApply (${selectedJobIds.size})`;
          send.disabled = selectedJobIds.size === 0;
        }, 3000);
      } catch (err) {
        console.error("AutoApply: Send error", err);
        send.textContent = "Error — try again";
        setTimeout(() => {
          send.textContent = `Send to AutoApply (${selectedJobIds.size})`;
          send.disabled = selectedJobIds.size === 0;
        }, 3000);
      }
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
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.15s;
        ${selectedJobIds.has(job.id) ? "background: #EEF2FF;" : ""}
      " data-job-id="${job.id}" class="autoapply-job-item">
        <input type="checkbox" ${selectedJobIds.has(job.id) ? "checked" : ""} style="
          width: 16px;
          height: 16px;
          accent-color: #4F46E5;
          cursor: pointer;
          flex-shrink: 0;
        " />
        <div style="flex: 1; min-width: 0;">
          <p style="margin: 0; font-size: 12px; font-weight: 500; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${job.title}
          </p>
          <p style="margin: 2px 0 0; font-size: 11px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${job.company} · ${job.location}
            ${job.easyApply ? '<span style="color: #4F46E5; font-weight: 500; margin-left: 4px;">Easy Apply</span>' : ""}
          </p>
        </div>
      </div>
    `
      )
      .join("");

    list.querySelectorAll(".autoapply-job-item").forEach((item) => {
      item.addEventListener("click", () => {
        const id = item.getAttribute("data-job-id");
        if (selectedJobIds.has(id)) {
          selectedJobIds.delete(id);
        } else {
          selectedJobIds.add(id);
        }
        renderJobList();
        updateSendButton();
      });
    });

    updateSendButton();
  }

  function updateSendButton() {
    const send = document.getElementById("autoapply-send");
    const count = document.getElementById("autoapply-count");
    send.textContent = `Send to AutoApply (${selectedJobIds.size})`;
    send.disabled = selectedJobIds.size === 0;
    send.style.opacity = selectedJobIds.size === 0 ? "0.5" : "1";
    count.textContent = `${scrapedJobs.length}`;
  }

  // Initialize
  createFloatingUI();
})();
