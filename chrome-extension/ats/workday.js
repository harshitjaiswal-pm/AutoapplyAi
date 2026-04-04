/**
 * ATS CONTENT SCRIPT — Workday (*.myworkdayjobs.com, *.wd5.myworkdayjobs.com, etc.)
 *
 * Workday is the trickiest ATS — it uses a custom SPA framework with shadow DOM,
 * dynamic rendering, and non-standard form controls. This script handles the most
 * common Workday application layout.
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  console.log("AutoApply: Workday ATS script loaded on", window.location.href);

  // Workday renders slowly — wait longer
  setTimeout(() => init(), 4000);

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing Workday application for", pendingJob.jobTitle);
    showBanner("AutoApply: Tailoring your resume...");

    try {
      const pageJD = scrapeWorkdayJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      const tailoredData = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "TAILOR_AND_FILL",
          job: { ...pendingJob, jobDescription },
        }, (response) => {
          if (response?.error) reject(new Error(response.error));
          else resolve(response);
        });
      });

      if (!tailoredData?.tailoredResult) {
        showBanner("AutoApply: Tailoring failed. Please apply manually.", "error");
        return;
      }

      showBanner("AutoApply: Filling application form...");

      await fillWorkdayForm(tailoredData.tailoredResult, pendingJob);

      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      showBanner("AutoApply: Form filled where possible. Upload the downloaded resume and review.", "success");
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Workday error", err);
      showBanner(`AutoApply: Error — ${err.message}`, "error");
    }
  }

  function scrapeWorkdayJD() {
    // Workday JD containers
    const selectors = [
      '[data-automation-id="jobPostingDescription"]',
      '[class*="jobDescription"]',
      '[data-automation-id="job-posting-about"]',
      ".css-cygeeu", // common Workday description class
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    // Fallback: look for large text blocks
    const allDivs = document.querySelectorAll("div, section");
    let bestText = "";
    for (const div of allDivs) {
      const text = div.innerText?.trim() || "";
      if (text.length > 300 && text.length < 10000 &&
        (text.includes("Responsibilities") || text.includes("Qualifications") ||
          text.includes("Requirements") || text.includes("About")) &&
        text.length > bestText.length) {
        bestText = text;
      }
    }

    return bestText;
  }

  async function fillWorkdayForm(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    // Workday uses data-automation-id attributes
    fillWorkdayInput('[data-automation-id="legalNameSection_firstName"]', user.firstName || "");
    fillWorkdayInput('[data-automation-id="legalNameSection_lastName"]', user.lastName || "");
    fillWorkdayInput('[data-automation-id="email"]', user.email || "");
    fillWorkdayInput('[data-automation-id="phone-number"]', user.phone || "");

    // Also try generic input matching
    fillInputByLabel("First Name", user.firstName || "");
    fillInputByLabel("Last Name", user.lastName || "");
    fillInputByLabel("Email", user.email || "");
    fillInputByLabel("Phone", user.phone || "");

    // Cover letter if there's a text area
    if (tailoredResult.coverLetter) {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const label = ta.closest("div")?.querySelector("label")?.textContent?.toLowerCase() || "";
        if (label.includes("cover") || label.includes("additional") || label.includes("letter")) {
          ta.value = tailoredResult.coverLetter;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }
    }
  }

  function fillWorkdayInput(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el && !el.value) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
    }
  }

  function fillInputByLabel(labelText, value) {
    if (!value) return;
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      if (label.textContent?.trim().toLowerCase().includes(labelText.toLowerCase())) {
        const forId = label.getAttribute("for");
        const input = forId
          ? document.getElementById(forId)
          : label.closest("div")?.querySelector("input, textarea");
        if (input && !input.value) {
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.blur();
        }
        return;
      }
    }
  }

  function showBanner(message, type = "info") {
    let banner = document.getElementById("autoapply-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "autoapply-banner";
      banner.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
        padding: 12px 20px; font-family: -apple-system, sans-serif;
        font-size: 13px; font-weight: 500; text-align: center;
        transition: all 0.3s; box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      `;
      document.body.appendChild(banner);
    }
    const colors = {
      info: { bg: "#EEF2FF", text: "#4338CA", border: "#C7D2FE" },
      success: { bg: "#F0FDF4", text: "#166534", border: "#BBF7D0" },
      error: { bg: "#FEF2F2", text: "#991B1B", border: "#FECACA" },
    };
    const c = colors[type] || colors.info;
    banner.style.background = c.bg;
    banner.style.color = c.text;
    banner.style.borderBottom = `1px solid ${c.border}`;
    banner.textContent = message;
    if (type !== "info") setTimeout(() => { if (banner) banner.remove(); }, 10000);
  }
})();
