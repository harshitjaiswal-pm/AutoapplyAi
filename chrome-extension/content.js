/**
 * CONTENT SCRIPT — Runs on LinkedIn job search pages.
 *
 * Scrapes job cards from the search results and provides a UI
 * to select which jobs to send to AutoApply AI.
 */

(() => {
  // Avoid double-injection
  if (window.__autoapply_injected) return;
  window.__autoapply_injected = true;

  const SELECTORS = {
    // LinkedIn job card selectors (may need updating as LinkedIn changes their DOM)
    jobCard: ".job-card-container, .jobs-search-results__list-item, .scaffold-layout__list-item",
    jobTitle: ".job-card-list__title, .job-card-container__link, a.job-card-list__title--link",
    company: ".job-card-container__primary-description, .artdeco-entity-lockup__subtitle",
    location: ".job-card-container__metadata-item, .artdeco-entity-lockup__caption",
    easyApplyBadge: ".job-card-container__footer-job-state, .jobs-apply-button--top-card",
    jobLink: "a.job-card-list__title--link, a.job-card-container__link",
    // Job detail panel (right side)
    detailPanel: ".jobs-search__job-details, .job-view-layout",
    detailTitle: ".job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title",
    detailCompany: ".job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name",
    detailDescription: ".jobs-description__content, .jobs-description-content__text",
  };

  // State
  let scrapedJobs = [];
  let selectedJobIds = new Set();

  /**
   * Scrape all visible job cards from the search results list.
   */
  function scrapeJobCards() {
    const cards = document.querySelectorAll(SELECTORS.jobCard);
    const jobs = [];

    cards.forEach((card, index) => {
      try {
        const titleEl = card.querySelector(SELECTORS.jobTitle);
        const companyEl = card.querySelector(SELECTORS.company);
        const locationEl = card.querySelector(SELECTORS.location);
        const linkEl = card.querySelector(SELECTORS.jobLink);
        const easyApplyEl = card.querySelector(SELECTORS.easyApplyBadge);

        const title = titleEl?.textContent?.trim() ?? "";
        const company = companyEl?.textContent?.trim() ?? "";
        const location = locationEl?.textContent?.trim() ?? "";
        const url = linkEl?.href ?? "";
        const easyApply =
          easyApplyEl?.textContent?.toLowerCase().includes("easy apply") ??
          card.innerHTML.toLowerCase().includes("easy apply");

        if (title) {
          jobs.push({
            id: `li_${Date.now()}_${index}`,
            title,
            company,
            location,
            url: url.split("?")[0], // Clean URL
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
   * Scrape the full job description from the detail panel.
   */
  function scrapeJobDescription() {
    const descEl = document.querySelector(SELECTORS.detailDescription);
    return descEl?.innerText?.trim() ?? "";
  }

  /**
   * Create the floating AutoApply button on the page.
   */
  function createFloatingUI() {
    // Remove existing if present
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
        <!-- Collapsed button -->
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

        <!-- Expanded panel -->
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
              <input id="autoapply-url" type="text" placeholder="AutoApply URL (e.g., https://autoapply-ai-delta.vercel.app)" style="
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

      // Save URL for next time
      chrome.storage.local.set({ autoapplyUrl: url });

      const selectedJobs = scrapedJobs.filter((j) => selectedJobIds.has(j.id));
      if (selectedJobs.length === 0) return;

      // For each selected job, try to scrape the full description
      send.textContent = "Scraping descriptions...";
      send.disabled = true;

      const jobsWithDescriptions = [];
      for (const job of selectedJobs) {
        // Click on each job card to load its description
        const cards = document.querySelectorAll(SELECTORS.jobCard);
        let description = "";

        for (const card of cards) {
          const titleEl = card.querySelector(SELECTORS.jobTitle);
          if (titleEl?.textContent?.trim() === job.title) {
            card.click();
            // Wait for the detail panel to load
            await new Promise((r) => setTimeout(r, 1500));
            description = scrapeJobDescription();
            break;
          }
        }

        jobsWithDescriptions.push({
          ...job,
          description: description || `${job.title} at ${job.company} - ${job.location}`,
        });

        send.textContent = `Scraping... (${jobsWithDescriptions.length}/${selectedJobs.length})`;
      }

      // Send to AutoApply AI
      send.textContent = "Sending to AutoApply...";

      try {
        // Store jobs in chrome.storage for the AutoApply app to read
        // AND attempt to open the pipeline page with the jobs
        const payload = jobsWithDescriptions.map((j) => ({
          jobTitle: j.title,
          company: j.company,
          location: j.location,
          jobUrl: j.url,
          jobDescription: j.description,
          easyApply: j.easyApply,
          source: "linkedin",
        }));

        // Open AutoApply pipeline page
        const pipelineUrl = `${url}/pipeline?jobs=${encodeURIComponent(
          JSON.stringify(payload)
        )}`;

        // If payload is too large for URL, use clipboard
        if (pipelineUrl.length > 8000) {
          // Store in chrome.storage and open with a flag
          chrome.storage.local.set({ pendingJobs: payload });
          window.open(`${url}/pipeline?fromExtension=true`, "_blank");
          send.textContent = `Sent ${selectedJobs.length} jobs!`;
        } else {
          window.open(pipelineUrl, "_blank");
          send.textContent = `Sent ${selectedJobs.length} jobs!`;
        }

        setTimeout(() => {
          send.textContent = `Send to AutoApply (${selectedJobIds.size})`;
          send.disabled = selectedJobIds.size === 0;
        }, 3000);
      } catch (err) {
        console.error("AutoApply: Send error", err);
        send.textContent = "Error sending — try again";
        setTimeout(() => {
          send.textContent = `Send to AutoApply (${selectedJobIds.size})`;
          send.disabled = selectedJobIds.size === 0;
        }, 3000);
      }
    });

    // Save URL on change
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

    // Attach click listeners
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
