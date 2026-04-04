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
      document.body.appendChild(banner);
    }
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: all 0.3s; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    `;
    const colors = {
      info: { bg: "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)", text: "#fff" },
      success: { bg: "linear-gradient(135deg, #059669 0%, #10B981 100%)", text: "#fff" },
      error: { bg: "linear-gradient(135deg, #DC2626 0%, #EF4444 100%)", text: "#fff" },
    };
    const c = colors[type] || colors.info;

    chrome.storage.local.get(["_aa_batchProgress"], (result) => {
      const bp = result._aa_batchProgress;
      let progressHTML = "";
      if (bp && bp.active) {
        progressHTML = `
          <div style="display: flex; align-items: center; gap: 14px;">
            <span style="
              background: rgba(255,255,255,0.2); border-radius: 8px; padding: 4px 12px;
              font-size: 16px; font-weight: 800; letter-spacing: -0.5px;
            ">Job ${bp.current}/${bp.total}</span>
            <span style="font-size: 13px; font-weight: 500;">${message}</span>
          </div>
          <div style="height: 3px; background: rgba(255,255,255,0.15); margin-top: 8px;">
            <div style="height: 100%; background: #34D399; width: ${Math.round((bp.current / bp.total) * 100)}%; border-radius: 0 2px 2px 0;"></div>
          </div>
        `;
      } else {
        progressHTML = `<div style="font-size: 13px; font-weight: 500;">${message}</div>`;
      }

      banner.style.background = c.bg;
      banner.style.color = c.text;
      banner.innerHTML = `<div style="padding: 10px 20px;">${progressHTML}</div>`;
    });

    if (type !== "info") setTimeout(() => { if (banner) banner.remove(); }, 10000);
  }
})();
