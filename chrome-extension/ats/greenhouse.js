/**
 * ATS CONTENT SCRIPT — Greenhouse (boards.greenhouse.io)
 *
 * Flow:
 * 1. Detect we're on a Greenhouse application page
 * 2. Scrape the job description
 * 3. Send to background.js for tailoring via AutoApply API
 * 4. Fill form fields with tailored data
 * 5. Upload the tailored resume PDF
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  console.log("AutoApply: Greenhouse ATS script loaded on", window.location.href);

  // Wait for page to be ready
  setTimeout(() => init(), 2000);

  async function init() {
    // Check if we have a pending application from the LinkedIn extension
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing application for", pendingJob.jobTitle);

    showBanner("AutoApply: Tailoring your resume...");

    try {
      // Step 1: Scrape the full JD from Greenhouse page (more reliable than LinkedIn)
      const pageJD = scrapeGreenhouseJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      // Step 2: Request tailoring from background
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

      // Step 3: Fill form fields
      await fillGreenhouseForm(tailoredData.tailoredResult, pendingJob);

      // Step 4: Upload resume
      if (tailoredData.resumeBlob) {
        await uploadResume(tailoredData.resumeBlob, pendingJob);
      }

      showBanner("AutoApply: Form filled! Review and submit.", "success");

      // Clear the pending application
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Greenhouse error", err);
      showBanner(`AutoApply: Error — ${err.message}. Apply manually.`, "error");
    }
  }

  function scrapeGreenhouseJD() {
    // Greenhouse has consistent selectors
    const selectors = [
      "#content .body",          // Job description body
      ".job-post-content",       // Alternative layout
      '[class*="job_description"]',
      "#content",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    return "";
  }

  async function fillGreenhouseForm(tailoredResult, job) {
    // Greenhouse forms typically have: first name, last name, email, phone, resume upload,
    // cover letter, LinkedIn URL, and custom questions

    // Fill text inputs
    const fieldMap = {
      "first_name": null,   // Will be set from stored profile
      "last_name": null,
      "email": null,
      "phone": null,
    };

    // Get user profile from storage
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    // Fill basic fields
    fillInput('input[name*="first_name"], input[id*="first_name"]', user.firstName || "");
    fillInput('input[name*="last_name"], input[id*="last_name"]', user.lastName || "");
    fillInput('input[name*="email"], input[id*="email"]', user.email || "");
    fillInput('input[name*="phone"], input[id*="phone"]', user.phone || "");

    // Fill LinkedIn URL
    fillInput('input[name*="linkedin"], input[id*="linkedin"]', user.linkedin || "");

    // Fill cover letter textarea
    if (tailoredResult.coverLetter) {
      fillTextarea(
        'textarea[name*="cover_letter"], textarea[id*="cover_letter"], textarea[name*="cover"]',
        tailoredResult.coverLetter
      );
    }

    // Fill any "How did you hear about us" type fields
    fillInput('input[name*="how_did_you_hear"], input[id*="source"]', "LinkedIn");
  }

  async function uploadResume(resumeBlobUrl, job) {
    // Find file input for resume
    const fileInputs = document.querySelectorAll('input[type="file"]');
    for (const input of fileInputs) {
      const label = input.closest("div")?.querySelector("label")?.textContent?.toLowerCase() || "";
      const name = (input.name || "").toLowerCase();

      if (label.includes("resume") || label.includes("cv") || name.includes("resume") || name.includes("cv")) {
        // We can't programmatically set file inputs due to security restrictions
        // Instead, show a message to the user
        showBanner("AutoApply: Please upload the tailored resume manually (downloaded to your Downloads folder).", "info");

        // Download the resume so user can upload it
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_RESUME",
          job: { company: job.company, jobTitle: job.jobTitle },
        });

        return;
      }
    }
  }

  /* ─── Form Fill Helpers ─── */

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

  /* ─── UI Banner ─── */

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

    // Auto-hide success/error after 10s
    if (type === "success" || type === "error") {
      setTimeout(() => { if (banner) banner.remove(); }, 10000);
    }
  }
})();
