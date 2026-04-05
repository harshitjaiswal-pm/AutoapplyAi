/**
 * ATS CONTENT SCRIPT — Lever (jobs.lever.co)
 *
 * Lever application pages have a clean, consistent structure.
 * Form fields: name, email, phone, resume upload, LinkedIn, cover letter, custom questions.
 *
 * Flow:
 * 1. Detect pending application from LinkedIn
 * 2. Scrape JD from Lever page (more reliable than LinkedIn)
 * 3. Send to background.js for AI tailoring
 * 4. Fill ALL form fields (basic + custom)
 * 5. Attempt programmatic resume upload
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  const LOG = (msg, ...args) => console.log(`AutoApply Lever: ${msg}`, ...args);
  LOG("Script loaded on", window.location.href);

  setTimeout(() => init(), 2000);

  /* ── Helpers ── */

  function sendMessageWithTimeout(message, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for response")), timeoutMs);
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  /* ── Main init ── */

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      LOG("No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    LOG("Processing Lever application for", pendingJob.jobTitle);
    showBanner("Preparing your application...", "ai");

    try {
      // Scrape JD from Lever page (more complete than LinkedIn)
      const pageJD = scrapeLeverJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      showBanner("Tailoring your resume for this role...", "ai", { subtext: "This may take 15–30 seconds." });

      // Request tailoring with timeout
      const tailoredData = await sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 90000);

      if (!tailoredData?.tailoredResult) {
        LOG("Tailoring returned no data, filling basic info only");
        showBanner("Tailoring returned no data — filling with base profile data.", "error");
        await fillBasicFieldsOnly();
        return;
      }

      showBanner("Filling application form...", "ai");
      LOG("Got tailored result, filling Lever form");

      await fillLeverForm(tailoredData.tailoredResult, pendingJob);

      // Attempt programmatic resume upload
      await attemptResumeUpload();

      showBanner("Form filled — review and submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      LOG("Error:", err.message);
      showBanner("Error filling form — filling basic info as fallback.", "error", { subtext: err.message });
      await fillBasicFieldsOnly();
    }
  }

  /* ── JD Scraping ── */

  function scrapeLeverJD() {
    const selectors = [
      ".section-wrapper .content",
      '[data-qa="job-description"]',
      ".posting-page .content",
      ".job-description",
      ".posting-categories + div",
      "[class*='posting-']",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    return "";
  }

  /* ── Form Filling ── */

  async function fillLeverForm(tailoredResult, job) {
    const stored = await chrome.storage.local.get(["userProfile"]);
    const user = stored.userProfile || {};

    if (!user.firstName && !user.email) {
      LOG("Warning: No user profile found — fields may be incomplete");
    }

    const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

    // Lever standard fields
    fillInput('input[name="name"]', fullName);
    fillInput('input[name="email"]', user.email || "");
    fillInput('input[name="phone"]', user.phone || "");

    // LinkedIn URL — Lever uses various name patterns
    fillInput('input[name*="linkedin"], input[name*="urls[LinkedIn]"], input[name*="urls[0]"]', user.linkedin || "");

    // GitHub / Portfolio
    if (user.github) {
      fillInput('input[name*="github"], input[name*="urls[GitHub]"], input[name*="urls[1]"]', user.github);
    }
    if (user.portfolio) {
      fillInput('input[name*="portfolio"], input[name*="urls[Portfolio]"], input[name*="website"], input[name*="urls[2]"]', user.portfolio);
    }

    // Cover letter / additional info
    if (tailoredResult.coverLetter) {
      fillTextarea('textarea[name*="comments"], textarea[name*="additional"], textarea[name*="coverLetter"]', tailoredResult.coverLetter);
    }

    // Try to fill custom questions by matching labels
    await fillCustomQuestions(tailoredResult, user);

    LOG("Form filling complete");
  }

  async function fillBasicFieldsOnly() {
    const stored = await chrome.storage.local.get(["userProfile"]);
    const user = stored.userProfile || {};
    const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

    fillInput('input[name="name"]', fullName);
    fillInput('input[name="email"]', user.email || "");
    fillInput('input[name="phone"]', user.phone || "");
    fillInput('input[name*="linkedin"], input[name*="urls[LinkedIn]"], input[name*="urls[0]"]', user.linkedin || "");

    LOG("Basic fields filled");
  }

  async function fillCustomQuestions(tailoredResult, user) {
    // Lever custom questions are typically in .custom-question containers
    const questions = document.querySelectorAll('.application-question, [class*="custom-question"], .additional-fields .field');
    if (questions.length === 0) return;

    LOG("Found", questions.length, "custom question containers");

    for (const q of questions) {
      const label = q.querySelector("label, .field-label, legend");
      if (!label) continue;
      const labelText = label.textContent.trim().toLowerCase();

      // Work authorization / sponsorship
      if (labelText.includes("sponsor") || labelText.includes("authorization") || labelText.includes("authorised") || labelText.includes("legally")) {
        const select = q.querySelector("select");
        const radios = q.querySelectorAll('input[type="radio"]');
        const value = user.requireSponsorship === "yes" ? "Yes" : "No";

        if (select) {
          fillSelect(select, value);
        } else if (radios.length > 0) {
          fillRadio(radios, value);
        }
        continue;
      }

      // How did you hear about us
      if (labelText.includes("hear about") || labelText.includes("how did you") || labelText.includes("referral")) {
        const input = q.querySelector("input[type='text'], textarea");
        const select = q.querySelector("select");
        const value = user.howDidYouHear || "LinkedIn";

        if (input) {
          fillInputEl(input, value);
        } else if (select) {
          fillSelect(select, value);
        }
        continue;
      }

      // Gender / Pronouns
      if (labelText.includes("pronoun") || labelText.includes("gender")) {
        const select = q.querySelector("select");
        if (select && user.pronouns) {
          fillSelect(select, user.pronouns);
        }
        continue;
      }

      // Location / city
      if (labelText.includes("current location") || labelText.includes("where are you") || labelText.includes("city")) {
        const input = q.querySelector("input[type='text'], textarea");
        if (input) {
          fillInputEl(input, user.city || user.location || "");
        }
        continue;
      }
    }
  }

  /* ── Resume Upload ── */

  async function attemptResumeUpload() {
    // Get the tailored resume PDF from storage
    const stored = await chrome.storage.local.get(["tailoredResumePdf"]);
    if (!stored.tailoredResumePdf) {
      LOG("No tailored resume PDF in storage — downloading instead");
      // Fall back to download
      chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: {} });
      return;
    }

    // Find the resume file input
    const fileInput = document.querySelector('input[type="file"][name*="resume"], input[type="file"]');
    if (!fileInput) {
      LOG("No file input found for resume upload");
      chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: {} });
      return;
    }

    LOG("Found file input, attempting programmatic upload");

    try {
      // Convert base64 to File object
      const binaryStr = atob(stored.tailoredResumePdf);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "application/pdf" });
      const file = new File([blob], "Resume.pdf", { type: "application/pdf" });

      // Strategy 1: Call React's onChange handler directly (bypasses isTrusted check)
      const reactPropsKey = Object.keys(fileInput).find(k => k.startsWith("__reactProps$"));
      if (reactPropsKey && fileInput[reactPropsKey]?.onChange) {
        const dt = new DataTransfer();
        dt.items.add(file);
        const fakeEvent = {
          target: { files: dt.files },
          currentTarget: { files: dt.files },
          preventDefault: () => {},
          stopPropagation: () => {},
          nativeEvent: new Event("change"),
          type: "change",
          bubbles: true,
        };
        fileInput[reactPropsKey].onChange(fakeEvent);
        LOG("Resume uploaded via React onChange handler");
        showBanner("Resume uploaded successfully!", "ai");
        return;
      }

      // Strategy 2: DataTransfer + change event
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      Object.defineProperty(fileInput, "files", {
        value: dataTransfer.files,
        writable: true,
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      LOG("Resume uploaded via fallback (defineProperty + change event)");
      showBanner("Resume uploaded successfully!", "ai");

    } catch (err) {
      LOG("Resume upload failed:", err.message);
      // Fall back to download
      chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: {} });
    }
  }

  /* ── Field Helpers ── */

  function fillInput(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el) {
      fillInputEl(el, value);
    }
  }

  function fillInputEl(el, value) {
    if (!el || !value) return;
    // Fill even if already has value (overwrite with better data)
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
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

  function fillSelect(selectEl, value) {
    if (!selectEl || !value) return;
    const valueLower = value.toLowerCase();
    const options = selectEl.querySelectorAll("option");
    for (const opt of options) {
      const optText = opt.textContent.trim().toLowerCase();
      if (optText === valueLower || optText.includes(valueLower) || valueLower.includes(optText)) {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        LOG("Selected option:", opt.textContent.trim(), "for", selectEl.name);
        return;
      }
    }
    LOG("No matching option found for value:", value);
  }

  function fillRadio(radios, value) {
    if (!radios || !value) return;
    const valueLower = value.toLowerCase();
    for (const radio of radios) {
      const label = radio.closest("label")?.textContent?.trim().toLowerCase()
        || radio.nextSibling?.textContent?.trim().toLowerCase()
        || radio.value?.toLowerCase() || "";
      if (label.includes(valueLower) || valueLower.includes(label)) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        LOG("Selected radio:", label);
        return;
      }
    }
  }

  /* ── Banner UI ── */

  function showBanner(message, type = "ai", opts = {}) {
    let banner = document.getElementById("autoapply-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "autoapply-banner";
      document.body.appendChild(banner);
    }

    if (banner._timerInterval) { clearInterval(banner._timerInterval); banner._timerInterval = null; }
    if (banner._dismissTimer)  { clearTimeout(banner._dismissTimer);  banner._dismissTimer  = null; }

    const isAi = (type === "ai" || type === "info");
    if (isAi) {
      if (!banner._timerStart) banner._timerStart = Date.now();
    } else {
      banner._timerStart = null;
    }
    const timerStart = banner._timerStart;

    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    `;

    const typeConfig = {
      ai:      { bg: "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)", icon: "🤖", actor: "AutoApply AI" },
      info:    { bg: "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)", icon: "🤖", actor: "AutoApply AI" },
      user:    { bg: "linear-gradient(135deg, #B45309 0%, #D97706 100%)", icon: "👆", actor: "Your turn" },
      success: { bg: "linear-gradient(135deg, #047857 0%, #059669 100%)", icon: "✅", actor: "Done" },
      error:   { bg: "linear-gradient(135deg, #B91C1C 0%, #DC2626 100%)", icon: "⚠️", actor: "Issue" },
    };
    const cfg = typeConfig[type] || typeConfig.ai;

    chrome.storage.local.get(["_aa_batchProgress"], (result) => {
      const bp = result._aa_batchProgress;
      const hasBatch = bp && bp.total > 0;

      const batchTag = hasBatch
        ? `<span style="background:rgba(255,255,255,0.18);border-radius:6px;padding:2px 10px;font-size:13px;font-weight:700;white-space:nowrap;">Job ${bp.current} / ${bp.total}</span>`
        : "";
      const jobLabel = hasBatch && bp.title
        ? `<span style="font-size:12px;opacity:0.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${bp.title}${bp.company ? " · " + bp.company : ""}</span>`
        : "";

      const pct = hasBatch ? Math.round(((bp.current - 1) / bp.total) * 100) : 0;
      const progressBar = hasBatch ? `
        <div style="height:3px;background:rgba(255,255,255,0.2);margin:6px 0 4px;">
          <div style="height:100%;width:${pct}%;background:rgba(255,255,255,0.7);border-radius:2px;transition:width 0.4s;"></div>
        </div>` : "";

      const actorBadge = `<span style="font-size:11px;font-weight:700;background:rgba(255,255,255,0.2);border-radius:4px;padding:1px 7px;letter-spacing:0.3px;">${cfg.icon} ${cfg.actor.toUpperCase()}</span>`;
      const statusMsg  = `<span style="font-size:13px;font-weight:500;">${message}</span>`;
      const timerEl    = isAi
        ? `<span id="aa-elapsed-timer" style="font-size:11px;opacity:0.6;margin-left:auto;font-variant-numeric:tabular-nums;letter-spacing:0.5px;">0:00</span>`
        : "";

      const subtextRow = opts.subtext
        ? `<div style="font-size:11px;opacity:0.75;margin-top:3px;padding-left:2px;">${opts.subtext}</div>`
        : "";

      banner.style.background = cfg.bg;
      banner.style.color = "#fff";
      banner.innerHTML = `
        <div style="padding:8px 18px 7px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${batchTag}${jobLabel}</div>
          ${progressBar}
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">${actorBadge}${statusMsg}${timerEl}</div>
          ${subtextRow}
        </div>`;

      if (isAi && timerStart) {
        banner._timerInterval = setInterval(() => {
          const el = document.getElementById("aa-elapsed-timer");
          if (!el) return;
          const elapsed = Math.floor((Date.now() - timerStart) / 1000);
          const m = Math.floor(elapsed / 60);
          const s = elapsed % 60;
          el.textContent = `${m}:${s.toString().padStart(2, "0")}`;
        }, 1000);
      }
    });

    if (type === "success") banner._dismissTimer = setTimeout(() => banner.remove(), 15000);
    if (type === "error")   banner._dismissTimer = setTimeout(() => banner.remove(), 20000);
  }
})();
