/**
 * ATS CONTENT SCRIPT — Lever (jobs.lever.co)
 *
 * Lever application pages have a clean, consistent structure.
 * Form fields: name, email, phone, resume upload, LinkedIn, cover letter, custom questions.
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  console.log("AutoApply: Lever ATS script loaded on", window.location.href);

  setTimeout(() => init(), 2000);

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing Lever application for", pendingJob.jobTitle);
    showBanner("AutoApply: Tailoring your resume...");

    try {
      // Scrape JD from Lever page
      const pageJD = scrapeLeverJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      // Request tailoring
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

      await fillLeverForm(tailoredData.tailoredResult, pendingJob);

      // Download resume for manual upload
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      showBanner("AutoApply: Form filled! Upload the downloaded resume and review before submitting.", "success");
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Lever error", err);
      showBanner(`AutoApply: Error — ${err.message}`, "error");
    }
  }

  function scrapeLeverJD() {
    // Lever JD is typically in .section-wrapper .content or .posting-page
    const selectors = [
      ".section-wrapper .content",
      '[data-qa="job-description"]',
      ".posting-page .content",
      ".job-description",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    return "";
  }

  async function fillLeverForm(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    // Lever form fields
    fillInput('input[name="name"]', `${user.firstName || ""} ${user.lastName || ""}`.trim());
    fillInput('input[name="email"]', user.email || "");
    fillInput('input[name="phone"]', user.phone || "");
    fillInput('input[name*="linkedin"], input[name*="urls[LinkedIn]"]', user.linkedin || "");

    // Cover letter / additional info
    if (tailoredResult.coverLetter) {
      fillTextarea('textarea[name*="comments"], textarea[name*="additional"]', tailoredResult.coverLetter);
    }
  }

  function fillInput(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el && !el.value) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function fillTextarea(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
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
