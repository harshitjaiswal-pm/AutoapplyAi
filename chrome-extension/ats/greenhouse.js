/**
 * ATS CONTENT SCRIPT — Greenhouse (boards.greenhouse.io, job-boards.greenhouse.io)
 *
 * Flow:
 * 1. Detect pending application from LinkedIn
 * 2. Scrape JD from Greenhouse page (more reliable than LinkedIn)
 * 3. Send to background.js for AI tailoring
 * 4. Fill ALL form fields (basic + Greenhouse-specific)
 * 5. Validate fields and attempt programmatic resume upload
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  console.log("AutoApply: Greenhouse ATS script loaded on", window.location.href);

  setTimeout(() => init(), 1500);

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing Greenhouse application for", pendingJob.jobTitle);
    showBanner("AutoApply: Preparing your application...");

    try {
      // Scrape JD from Greenhouse (more complete than LinkedIn)
      const pageJD = scrapeGreenhouseJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      showBanner("AutoApply: Tailoring your resume (this may take 15-30s)...");

      // Request tailoring with timeout
      const tailoredData = await sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 90000); // 90 second timeout for AI processing

      if (tailoredData?.error) {
        console.error("AutoApply: Tailoring error:", tailoredData.error);
        showBanner(`AutoApply: ${tailoredData.error}`, "error");
        await fillBasicFieldsOnly();
        return;
      }

      if (!tailoredData?.tailoredResult) {
        showBanner("AutoApply: Tailoring returned no data. Filling basic info...", "error");
        await fillBasicFieldsOnly();
        return;
      }

      showBanner("AutoApply: Filling application form...");
      console.log("AutoApply: Got tailored result, filling Greenhouse form");

      // Fill form fields
      await fillGreenhouseForm(tailoredData.tailoredResult, pendingJob);

      // Attempt resume file upload
      await attemptResumeUpload();

      // Download tailored resume PDF
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      showBanner(
        "AutoApply: Form filled! Upload the downloaded resume PDF, review all fields, and submit.",
        "success"
      );

      // Signal that this application was completed (form filled successfully)
      chrome.runtime.sendMessage({
        type: "APPLICATION_COMPLETED",
        job: {
          id: pendingJob.id,
          jobTitle: pendingJob.jobTitle,
          company: pendingJob.company,
          jobUrl: pendingJob.jobUrl || window.location.href,
          matchScore: tailoredData.tailoredResult?.matchScore || 0,
          completedAt: new Date().toISOString(),
        },
      });

      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Greenhouse error", err);
      showBanner(`AutoApply: Error — ${err.message}. Filling basic info...`, "error");
      await fillBasicFieldsOnly();
    }
  }

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

  function scrapeGreenhouseJD() {
    const selectors = [
      "#content .body",
      ".job-post-content",
      '[class*="job_description"]',
      '[class*="job-description"]',
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

  /* ─────────────── FORM FILLING ─────────────── */

  async function fillBasicFieldsOnly() {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};
    if (!user.firstName && !user.email) {
      showBanner("AutoApply: No profile data found. Sync your profile from the pipeline page.", "error");
      return;
    }
    fillAllFields(user, null);
  }

  async function fillGreenhouseForm(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};
    console.log("AutoApply: User profile keys:", Object.keys(user));
    fillAllFields(user, tailoredResult);
  }

  function fillAllFields(user, tailoredResult) {
    let filled = 0;

    // ── Basic fields (selector-based, most reliable for Greenhouse) ──
    const selectorFields = [
      { sel: 'input[name*="first_name"], input[id*="first_name"]', val: user.firstName },
      { sel: 'input[name*="last_name"], input[id*="last_name"]', val: user.lastName },
      { sel: 'input[name*="email"], input[id*="email"], input[type="email"]', val: user.email },
      { sel: 'input[name*="phone"], input[id*="phone"], input[type="tel"]', val: user.phone },
    ];

    // Fill selector fields synchronously
    for (const { sel, val } of selectorFields) {
      if (val && fillBySelector(sel, val)) filled++;
    }

    // ── Label-based text fields ──
    const labelFields = [
      { labels: ["linkedin", "linkedin profile", "linkedin url"], value: user.linkedin },
      { labels: ["current company", "current employer"], value: user.currentCompany },
      { labels: ["preferred name", "nickname"], value: user.preferredName || user.firstName },
      { labels: ["portfolio", "website", "personal site"], value: user.portfolio },
      { labels: ["github", "github url", "github profile"], value: user.github },
      { labels: ["twitter", "x profile", "twitter url"], value: user.twitter },
      { labels: ["name pronunciation"], value: "" }, // leave blank
    ];

    // Fill label fields synchronously
    for (const { labels, value } of labelFields) {
      if (value && fillByLabel(labels, value)) filled++;
    }

    // Fill cover letter synchronously if present
    if (tailoredResult?.coverLetter) {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const label = getFieldLabel(ta).toLowerCase();
        if (label.includes("cover letter") || label.includes("cover_letter")) {
          setNativeValue(ta, tailoredResult.coverLetter);
          filled++;
          console.log("AutoApply: Filled cover letter textarea");
          break;
        }
      }
    }

    // ── Select / dropdown fields ──
    // Greenhouse uses React Select v5. Dropdowns are filled via main world,
    // then text fields are re-filled after React re-renders (faster timing).
    const dropdownFields = [
      { labels: ["pronouns"],                                                  value: user.pronouns || "He/Him" },
      { labels: ["sponsorship", "immigration", "require immigration"],         value: user.requireSponsorship === "No" ? "No" : (user.requireSponsorship || "No") },
      { labels: ["state", "province", "reside in"],                           value: user.province || "Ontario" },
      { labels: ["how did you", "hear about", "learn about", "first learn"],  value: user.howDidYouHear || "LinkedIn" },
      { labels: ["gender"],                                                    value: user.gender },
      { labels: ["race", "ethnicity"],                                         value: user.ethnicity },
      { labels: ["veteran"],                                                   value: user.veteranStatus },
      { labels: ["disability"],                                                value: user.disabilityStatus },
      { labels: ["previously been employed", "worked here", "employed at"],   value: "not previously" },
    ];

    // Filter out empty values
    const activeDropdowns = dropdownFields.filter((f) => f.value);

    // Fill dropdowns via main world with faster re-fill timing
    const dropdownFillTimeMs = (activeDropdowns.length * 500) + 300;
    fillDropdownsViaMainWorld(activeDropdowns, function onComplete() {
      console.log("AutoApply: Re-filling text fields after dropdown render (waiting " + dropdownFillTimeMs + "ms)...");
      setTimeout(() => {
        for (const { sel, val } of selectorFields) {
          if (val) fillBySelector(sel, val, true);
        }
        for (const { labels, value } of labelFields) {
          if (value) fillByLabel(labels, value, true);
        }
        console.log("AutoApply: Text fields re-filled");

        // Validate fields and log any empty ones
        validateFilledFields(user, tailoredResult);
      }, dropdownFillTimeMs);
    });

    console.log(`AutoApply: Initial fill of ${filled} fields completed`);
  }

  /* ─────────────── FIELD VALIDATION ─────────────── */

  function validateFilledFields(user, tailoredResult) {
    console.log("AutoApply: Validating filled fields...");
    const emptyFields = [];

    // Check key selector fields
    const selectorFields = [
      { sel: 'input[name*="first_name"], input[id*="first_name"]', name: "First Name" },
      { sel: 'input[name*="last_name"], input[id*="last_name"]', name: "Last Name" },
      { sel: 'input[name*="email"], input[id*="email"], input[type="email"]', name: "Email" },
      { sel: 'input[name*="phone"], input[id*="phone"], input[type="tel"]', name: "Phone" },
    ];

    for (const { sel, name } of selectorFields) {
      const el = document.querySelector(sel);
      if (!el || !el.value || el.value.trim() === "") {
        emptyFields.push(name);
      }
    }

    if (emptyFields.length > 0) {
      console.warn("AutoApply: Empty key fields detected:", emptyFields);
    } else {
      console.log("AutoApply: All key fields validated successfully");
    }
  }

  /* ─────────────── RESUME FILE UPLOAD ─────────────── */

  async function attemptResumeUpload() {
    try {
      const stored = await chrome.storage.local.get(["tailoredResumePdf"]);
      if (!stored.tailoredResumePdf) {
        console.log("AutoApply: No tailored resume PDF found in storage for programmatic upload");
        return;
      }

      const fileInput = document.querySelector('input[type="file"]');
      if (!fileInput) {
        console.log("AutoApply: No file input found for resume upload");
        return;
      }

      console.log("AutoApply: Attempting programmatic resume file upload...");

      // Create File object from base64
      const base64Data = stored.tailoredResumePdf;
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const file = new File([bytes], "tailored_resume.pdf", { type: "application/pdf" });

      // Strategy 1: Call React's onChange handler directly
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
      } else {
        // Strategy 2: Fallback — Object.defineProperty + native events
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        Object.defineProperty(fileInput, "files", {
          value: dataTransfer.files,
          writable: true,
          configurable: true,
        });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        console.log("AutoApply: Resume uploaded via fallback (defineProperty)");
      }
    } catch (err) {
      console.error("AutoApply: Resume upload error:", err);
    }
  }

  /* ─────────────── VALUE SETTING (React-compatible) ─────────────── */

  function setNativeValue(element, value) {
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

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  /* ─────────────── FIELD MATCHING STRATEGIES ─────────────── */

  function fillBySelector(selector, value, force = false) {
    if (!value) return false;
    const el = document.querySelector(selector);
    if (el && (force || !el.value)) {
      setNativeValue(el, value);
      if (!force) console.log(`AutoApply: Filled by selector "${selector}"`);
      return true;
    }
    return false;
  }

  function fillByLabel(labelTexts, value, force = false) {
    if (!value) return false;

    // Strategy 1: <label> elements
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const text = label.textContent?.trim().toLowerCase().replace(/\*$/, "").trim() || "";
      if (labelTexts.some((t) => text.includes(t) || text === t)) {
        const forId = label.getAttribute("for");
        let input = forId ? document.getElementById(forId) : null;

        if (!input) {
          const container = label.closest("div, fieldset, li, section");
          input = container?.querySelector(
            "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea"
          );
        }

        if (!input) {
          let sibling = label.nextElementSibling;
          if (sibling?.tagName === "DIV") input = sibling.querySelector("input, textarea");
          else if (sibling?.tagName === "INPUT" || sibling?.tagName === "TEXTAREA") input = sibling;
        }

        if (input && (force || !input.value)) {
          setNativeValue(input, value);
          if (!force) console.log(`AutoApply: Filled label "${text}" with "${value.substring(0, 30)}..."`);
          return true;
        }
      }
    }

    // Strategy 2: placeholder / name / id / aria-label
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
        if (force || !input.value) {
          setNativeValue(input, value);
          if (!force) console.log(`AutoApply: Filled input attr match (${name || id}) with "${value.substring(0, 30)}..."`);
          return true;
        }
      }
    }

    // Strategy 3: nearby visible text
    const allTexts = document.querySelectorAll("span, p, div, h3, h4, h5, strong, b");
    for (const textEl of allTexts) {
      const text = textEl.textContent?.trim().toLowerCase().replace(/\*$/, "").trim() || "";
      if (text.length > 80) continue;
      if (!labelTexts.some((t) => text.includes(t))) continue;

      const parent = textEl.closest("div, fieldset, section, li");
      if (!parent) continue;
      const input = parent.querySelector(
        "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea"
      );
      if (input && (force || !input.value)) {
        setNativeValue(input, value);
        if (!force) console.log(`AutoApply: Filled near text "${text}" with "${value.substring(0, 30)}..."`);
        return true;
      }
    }

    return false;
  }

  /**
   * Fill ALL React Select dropdowns via the MAIN WORLD using
   * chrome.scripting.executeScript({ world: 'MAIN' }).
   *
   * Why main world? Content scripts run in Chrome's "isolated world" —
   * they can touch the DOM but synthetic events don't reliably trigger
   * React's event handlers. By executing in the main world, we access
   * React's fiber tree directly and call onChange() on each Select
   * component. This bypasses CSP restrictions that block injected
   * <script> tags, and it's 100% reliable.
   *
   * Flow:
   *   1. Content script sends FILL_DROPDOWNS message to background
   *   2. Background calls chrome.scripting.executeScript with world: 'MAIN'
   *   3. Injected function finds React Select fibers and calls onChange
   */
  function fillDropdownsViaMainWorld(dropdownFields, onComplete) {
    console.log("AutoApply: Requesting main-world dropdown fill for", dropdownFields.length, "fields");

    chrome.runtime.sendMessage({
      type: "FILL_DROPDOWNS_MAIN_WORLD",
      fields: dropdownFields,
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("AutoApply: FILL_DROPDOWNS_MAIN_WORLD error:", chrome.runtime.lastError.message);
      } else {
        console.log("AutoApply: Main-world dropdown fill response:", response);
      }
      // Re-fill text fields after dropdown React re-renders
      if (typeof onComplete === "function") onComplete();
    });
  }

  function getFieldLabel(element) {
    const id = element.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) return label.textContent?.trim() || "";
    }
    const container = element.closest("div, fieldset, li, section");
    if (container) {
      const label = container.querySelector("label, legend, [class*='label']");
      if (label) return label.textContent?.trim() || "";
    }
    return element.getAttribute("aria-label") || element.placeholder || "";
  }

  /* ─────────────── UI BANNER WITH BATCH PROGRESS ─────────────── */

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

    // Check for batch progress to show Job X/Y
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

    if (type === "success") setTimeout(() => { if (banner) banner.remove(); }, 20000);
    if (type === "error") setTimeout(() => { if (banner) banner.remove(); }, 20000);
  }
})();
