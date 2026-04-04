/**
 * ATS CONTENT SCRIPT — Generic fallback for unknown career sites
 *
 * This runs on any external apply page that isn't Greenhouse, Lever, or Workday.
 * It uses heuristics to find and fill common form fields.
 *
 * Triggered by background.js when it detects a new tab opened from LinkedIn Apply.
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  console.log("AutoApply: Generic ATS script loaded on", window.location.href);

  setTimeout(() => init(), 3000);

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing generic application for", pendingJob.jobTitle);
    showBanner("AutoApply: Tailoring your resume...");

    try {
      // Try to scrape JD from whatever page we're on
      const pageJD = scrapeGenericJD();
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

      showBanner("AutoApply: Filling form fields...");

      await fillGenericForm(tailoredData.tailoredResult, pendingJob);

      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      showBanner("AutoApply: Fields filled where possible. Upload the downloaded resume and review.", "success");
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Generic ATS error", err);
      showBanner(`AutoApply: Error — ${err.message}`, "error");
    }
  }

  function scrapeGenericJD() {
    // Try common JD containers
    const selectors = [
      '[class*="description"]',
      '[class*="job-detail"]',
      '[id*="description"]',
      'article',
      'main',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 200) {
        return el.innerText.trim();
      }
    }

    return "";
  }

  async function fillGenericForm(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    // Try to find and fill common fields by label text
    const fieldMappings = [
      { labels: ["first name", "given name", "prénom"], value: user.firstName },
      { labels: ["last name", "family name", "surname", "nom"], value: user.lastName },
      { labels: ["email", "e-mail"], value: user.email },
      { labels: ["phone", "telephone", "mobile"], value: user.phone },
      { labels: ["linkedin", "linkedin url", "linkedin profile"], value: user.linkedin },
    ];

    for (const mapping of fieldMappings) {
      if (!mapping.value) continue;
      fillByLabel(mapping.labels, mapping.value);
    }

    // Fill cover letter in any large textarea
    if (tailoredResult.coverLetter) {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const label = getFieldLabel(ta).toLowerCase();
        if (label.includes("cover") || label.includes("letter") ||
            label.includes("additional") || label.includes("message") ||
            label.includes("comments")) {
          ta.value = tailoredResult.coverLetter;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }
    }

    // Try to fill "full name" field
    if (user.firstName && user.lastName) {
      fillByLabel(["full name", "name", "your name"], `${user.firstName} ${user.lastName}`);
    }
  }

  function fillByLabel(labelTexts, value) {
    if (!value) return;

    // Strategy 1: match <label> elements
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const labelText = label.textContent?.trim().toLowerCase() || "";
      if (labelTexts.some((t) => labelText.includes(t))) {
        const forId = label.getAttribute("for");
        const input = forId
          ? document.getElementById(forId)
          : label.closest("div, fieldset, li")?.querySelector("input, textarea, select");
        if (input && !input.value) {
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      }
    }

    // Strategy 2: match by placeholder text
    const inputs = document.querySelectorAll("input, textarea");
    for (const input of inputs) {
      const placeholder = (input.placeholder || "").toLowerCase();
      const name = (input.name || "").toLowerCase();
      const id = (input.id || "").toLowerCase();
      const ariaLabel = (input.getAttribute("aria-label") || "").toLowerCase();

      if (labelTexts.some((t) =>
        placeholder.includes(t) || name.includes(t) || id.includes(t) || ariaLabel.includes(t)
      )) {
        if (!input.value) {
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      }
    }
  }

  function getFieldLabel(element) {
    // Try to find the label for a form element
    const id = element.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) return label.textContent?.trim() || "";
    }
    const container = element.closest("div, fieldset, li");
    if (container) {
      const label = container.querySelector("label");
      if (label) return label.textContent?.trim() || "";
    }
    return element.getAttribute("aria-label") || element.placeholder || "";
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
