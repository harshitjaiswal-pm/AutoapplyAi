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
    showBanner("Preparing application...", "ai");

    try {
      // Try to scrape JD from whatever page we're on
      const pageJD = scrapeGenericJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      if (!jobDescription || jobDescription.length < 30) {
        showBanner("No job description found — filling with base profile data.", "ai");
      }

      showBanner("Tailoring your resume for this role...", "ai", { subtext: "This may take 15–30 seconds." });

      // Send to background with a timeout
      const tailoredData = await sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 60000); // 60 second timeout

      if (tailoredData?.error) {
        console.error("AutoApply: Tailoring error:", tailoredData.error);
        showBanner("Tailoring had an issue — filling with base profile data.", "error", { subtext: tailoredData.error });
        // Still try to fill basic profile info
        await fillBasicProfile();
        return;
      }

      if (!tailoredData?.tailoredResult) {
        showBanner("Tailoring returned no data — filling with base profile data.", "error");
        await fillBasicProfile();
        return;
      }

      showBanner("Filling form fields...", "ai");
      console.log("AutoApply: Got tailored result, match score:", tailoredData.matchScore);

      await fillGenericForm(tailoredData.tailoredResult, pendingJob);

      // Attempt programmatic resume upload, fall back to download
      const uploaded = await attemptResumeUpload();
      if (!uploaded) {
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_RESUME",
          job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
        });
      }

      if (uploaded) {
        showBanner("Form filled & resume uploaded — review and submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
      } else {
        showBanner("Fields filled — upload the downloaded resume PDF, then review and submit.", "user", { subtext: "Check your Downloads folder for the tailored PDF." });
      }
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Generic ATS error", err);
      showBanner("Error filling form — filling basic info as fallback.", "error", { subtext: err.message });
      // Still try to fill basic profile info even if tailoring fails
      await fillBasicProfile();
    }
  }

  /**
   * Send a chrome.runtime message with a timeout.
   */
  function sendMessageWithTimeout(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("API request timed out after " + (timeoutMs / 1000) + "s"));
      }, timeoutMs);

      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function scrapeGenericJD() {
    // Try common JD containers
    const selectors = [
      '[class*="description"]',
      '[class*="job-detail"]',
      '[id*="description"]',
      "article",
      "main",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 200) {
        return el.innerText.trim();
      }
    }

    return "";
  }

  /**
   * Fill just the basic profile fields (no tailored data needed).
   * Used as fallback when tailoring fails.
   */
  async function fillBasicProfile() {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    if (!user.firstName && !user.email) {
      showBanner("No profile data found — sync your profile from the extension panel.", "error");
      return;
    }

    let filled = 0;

    // Try combined name field first
    let filledFullName = false;
    if (user.firstName && user.lastName) {
      const fullName = `${user.firstName} ${user.lastName}`;
      if (fillByLabel(["full name", "your name", "first & last name", "first and last name"], fullName)) {
        filledFullName = true;
        filled++;
      }
    }

    // Only fill separate first/last name if combined didn't work
    if (!filledFullName) {
      if (user.firstName && fillByLabel(["first name", "given name", "prénom"], user.firstName)) filled++;
      if (user.lastName && fillByLabel(["last name", "family name", "surname", "nom"], user.lastName)) filled++;
    }

    const otherMappings = [
      { labels: ["email", "e-mail", "email address"], value: user.email },
      { labels: ["phone", "telephone", "mobile", "phone number"], value: user.phone },
      { labels: ["linkedin", "linkedin url", "linkedin profile"], value: user.linkedin },
    ];

    for (const mapping of otherMappings) {
      if (!mapping.value) continue;
      if (fillByLabel(mapping.labels, mapping.value)) filled++;
    }

    if (filled > 0) {
      showBanner(`Filled ${filled} fields — complete the rest manually and submit when ready.`, "user");
    }
  }

  async function fillGenericForm(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    console.log("AutoApply: User profile:", JSON.stringify(user));

    let filled = 0;

    // Try to fill combined "full name" / "first & last name" field FIRST
    // This prevents separate first/last fills from overwriting each other
    // on forms that use a single combined name field.
    let filledFullName = false;
    if (user.firstName && user.lastName) {
      const fullName = `${user.firstName} ${user.lastName}`;
      if (fillByLabel(["full name", "your name", "first & last name", "first and last name"], fullName)) {
        filledFullName = true;
        filled++;
      }
    }

    // Only fill separate first/last name fields if we didn't fill a combined name field
    if (!filledFullName) {
      const nameFieldMappings = [
        { labels: ["first name", "given name", "prénom"], value: user.firstName },
        { labels: ["last name", "family name", "surname", "nom"], value: user.lastName },
      ];
      for (const mapping of nameFieldMappings) {
        if (!mapping.value) continue;
        if (fillByLabel(mapping.labels, mapping.value)) filled++;
      }
    }

    // Other field mappings
    const fieldMappings = [
      { labels: ["email", "e-mail", "email address"], value: user.email },
      { labels: ["phone", "telephone", "mobile", "phone number"], value: user.phone },
      { labels: ["linkedin", "linkedin url", "linkedin profile"], value: user.linkedin },
      { labels: ["github", "github url", "github profile"], value: user.github },
      { labels: ["portfolio", "website", "personal website", "portfolio url"], value: user.portfolio },
      { labels: ["preferred name", "nickname", "what should we call you"], value: user.preferredName },
      { labels: ["pronoun", "pronouns", "preferred pronoun"], value: user.pronouns },
      { labels: ["city", "location", "address", "city, province", "city, state"], value: user.province ? `Vancouver, ${user.province}, Canada` : "" },
      { labels: ["how did you hear", "how did you find", "where did you hear", "referral source"], value: user.howDidYouHear },
      { labels: ["sponsorship", "visa sponsorship", "require sponsorship", "work authorization"], value: user.requireSponsorship },
      { labels: ["work authorization", "authorized to work", "legally authorized", "eligibility"], value: user.workAuthorization },
    ];

    for (const mapping of fieldMappings) {
      if (!mapping.value) continue;
      if (fillByLabel(mapping.labels, mapping.value)) filled++;
    }

    // Fill cover letter in any large textarea
    if (tailoredResult.coverLetter) {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const label = getFieldLabel(ta).toLowerCase();
        if (label.includes("cover") || label.includes("letter") ||
            label.includes("additional") || label.includes("message") ||
            label.includes("comments") || label.includes("note")) {
          setNativeValue(ta, tailoredResult.coverLetter);
          filled++;
          break;
        }
      }
    }

    console.log(`AutoApply: Filled ${filled} fields`);
    return filled;
  }

  /**
   * Set a form input value in a way that works with React, Vue, Angular, etc.
   * React overrides the native .value setter, so we need to use the native one
   * and dispatch proper events.
   */
  function setNativeValue(element, value) {
    // Use the native HTMLInputElement/HTMLTextAreaElement value setter
    // This bypasses React's synthetic event system
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    )?.set;

    const setter = element.tagName === "TEXTAREA" ? nativeTextareaValueSetter : nativeInputValueSetter;

    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }

    // Dispatch events that React and other frameworks listen for
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    // React 17+ also listens for this
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function fillByLabel(labelTexts, value) {
    if (!value) return false;

    // Strategy 1: match <label> elements
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const labelText = label.textContent?.trim().toLowerCase().replace(/\*$/, "").trim() || "";
      if (labelTexts.some((t) => labelText.includes(t) || labelText === t)) {
        const forId = label.getAttribute("for");
        let input = forId ? document.getElementById(forId) : null;

        // If no for attribute, search nearby
        if (!input) {
          // Look in same parent container
          const container = label.closest("div, fieldset, li, section");
          input = container?.querySelector("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea, select");
        }

        // Also try the next sibling element
        if (!input) {
          let sibling = label.nextElementSibling;
          if (sibling?.tagName === "DIV") {
            input = sibling.querySelector("input, textarea");
          } else if (sibling?.tagName === "INPUT" || sibling?.tagName === "TEXTAREA") {
            input = sibling;
          }
        }

        if (input) {
          console.log(`AutoApply: Filling "${labelText}" with "${value.substring(0, 20)}..."`);
          setNativeValue(input, value);
          return true;
        }
      }
    }

    // Strategy 2: match by placeholder, name, id, or aria-label
    const inputs = document.querySelectorAll(
      "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea"
    );
    for (const input of inputs) {
      const placeholder = (input.placeholder || "").toLowerCase();
      const name = (input.name || "").toLowerCase();
      const id = (input.id || "").toLowerCase();
      const ariaLabel = (input.getAttribute("aria-label") || "").toLowerCase();

      if (labelTexts.some((t) =>
        placeholder.includes(t) || name.includes(t) || id.includes(t) || ariaLabel.includes(t)
      )) {
        if (!input.value) {
          console.log(`AutoApply: Filling input (${name || id || placeholder}) with "${value.substring(0, 20)}..."`);
          setNativeValue(input, value);
          return true;
        }
      }
    }

    // Strategy 3: match by visible text near the input (for React-style forms
    // where label is rendered as a separate element without 'for' attribute)
    const allTexts = document.querySelectorAll("span, p, div, h3, h4, h5, h6, strong, b");
    for (const textEl of allTexts) {
      const text = textEl.textContent?.trim().toLowerCase().replace(/\*$/, "").trim() || "";
      if (text.length > 50) continue; // Skip long text blocks
      if (!labelTexts.some((t) => text === t || text.includes(t))) continue;

      // Found matching text — look for an input nearby
      const parent = textEl.closest("div, fieldset, section, li");
      if (!parent) continue;
      const input = parent.querySelector(
        "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea"
      );
      if (input && !input.value) {
        console.log(`AutoApply: Filling near text "${text}" with "${value.substring(0, 20)}..."`);
        setNativeValue(input, value);
        return true;
      }
    }

    return false;
  }

  async function attemptResumeUpload() {
    const stored = await chrome.storage.local.get(["tailoredResumePdf"]);
    if (!stored.tailoredResumePdf) {
      console.log("AutoApply: No tailored resume PDF in storage");
      return false;
    }

    // Find file input — prefer ones with resume/cv in name/label
    let fileInput = document.querySelector('input[type="file"][name*="resume"], input[type="file"][name*="cv"]');
    if (!fileInput) {
      // Try to find any file input near a "resume" or "cv" label
      const fileInputs = document.querySelectorAll('input[type="file"]');
      for (const fi of fileInputs) {
        const label = getFieldLabel(fi).toLowerCase();
        if (label.includes("resume") || label.includes("cv") || label.includes("upload")) {
          fileInput = fi;
          break;
        }
      }
      // Fall back to first file input
      if (!fileInput && fileInputs.length > 0) {
        fileInput = fileInputs[0];
      }
    }

    if (!fileInput) {
      console.log("AutoApply: No file input found for resume upload");
      return false;
    }

    try {
      const binaryStr = atob(stored.tailoredResumePdf);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "application/pdf" });
      const file = new File([blob], "Resume.pdf", { type: "application/pdf" });

      // Strategy 1: React onChange handler
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
        console.log("AutoApply: Resume uploaded via React onChange handler");
        return true;
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
      console.log("AutoApply: Resume uploaded via fallback (defineProperty + change event)");
      return true;

    } catch (err) {
      console.error("AutoApply: Resume upload failed:", err.message);
      return false;
    }
  }

  function getFieldLabel(element) {
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

  /**
   * showBanner(message, type, opts)
   *
   * type:
   *   "ai"      — AI is acting (purple). Used whenever the script is doing something.
   *   "user"    — User must act (amber). Banner stays until dismissed or state changes.
   *   "success" — Step or application completed (green). Auto-dismisses after 15s.
   *   "error"   — Something went wrong (red). Auto-dismisses after 20s.
   *   "info"    — Neutral (purple, same as ai).
   *
   * opts:
   *   subtext {string}  — Optional second line of smaller text below the main message.
   */
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
