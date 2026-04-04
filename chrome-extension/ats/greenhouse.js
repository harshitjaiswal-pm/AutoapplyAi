/**
 * ATS CONTENT SCRIPT — Greenhouse (boards.greenhouse.io, job-boards.greenhouse.io)
 *
 * Flow:
 * 1. Detect pending application from LinkedIn
 * 2. Scrape JD from Greenhouse page (more reliable than LinkedIn)
 * 3. Send to background.js for AI tailoring
 * 4. Fill ALL form fields (basic + Greenhouse-specific)
 * 5. Download tailored resume PDF for manual upload
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  console.log("AutoApply: Greenhouse ATS script loaded on", window.location.href);

  setTimeout(() => init(), 2500);

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

      // Download tailored resume PDF
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      showBanner(
        "AutoApply: Form filled! Upload the downloaded resume PDF, review all fields, and submit.",
        "success"
      );

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

    for (const { sel, val } of selectorFields) {
      if (val && fillBySelector(sel, val)) filled++;
    }

    // ── Label-based fields (catches Greenhouse custom fields) ──
    const labelFields = [
      { labels: ["linkedin", "linkedin profile", "linkedin url"], value: user.linkedin },
      { labels: ["current company", "current employer"], value: user.currentCompany || "" },
      { labels: ["preferred name", "nickname"], value: user.preferredName || user.firstName },
      { labels: ["portfolio", "website", "personal site"], value: user.portfolio || "" },
      { labels: ["github", "github url", "github profile"], value: user.github || "" },
      { labels: ["twitter", "x profile"], value: user.twitter || "" },
    ];

    for (const { labels, value } of labelFields) {
      if (value && fillByLabel(labels, value)) filled++;
    }

    // ── Dropdown / select fields ──
    // "Which U.S. State or Canadian Province do you reside in?"
    if (user.province || user.state) {
      fillSelect(["state", "province", "reside"], user.province || user.state);
    }

    // "How did you first learn about us?"
    fillSelect(["how did you", "hear about", "learn about", "source"], "LinkedIn");

    // ── Cover letter ──
    if (tailoredResult?.coverLetter) {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const label = getFieldLabel(ta).toLowerCase();
        if (label.includes("cover") || label.includes("letter") ||
            label.includes("additional") || label.includes("other links") ||
            label.includes("comments") || label.includes("message")) {
          setNativeValue(ta, tailoredResult.coverLetter);
          filled++;
          console.log("AutoApply: Filled cover letter textarea");
          break;
        }
      }
    }

    console.log(`AutoApply: Filled ${filled} fields total`);
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

  function fillBySelector(selector, value) {
    if (!value) return false;
    const el = document.querySelector(selector);
    if (el && !el.value) {
      setNativeValue(el, value);
      console.log(`AutoApply: Filled by selector "${selector}"`);
      return true;
    }
    return false;
  }

  function fillByLabel(labelTexts, value) {
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

        if (input && !input.value) {
          setNativeValue(input, value);
          console.log(`AutoApply: Filled label "${text}" with "${value.substring(0, 30)}..."`);
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
        if (!input.value) {
          setNativeValue(input, value);
          console.log(`AutoApply: Filled input attr match (${name || id}) with "${value.substring(0, 30)}..."`);
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
      if (input && !input.value) {
        setNativeValue(input, value);
        console.log(`AutoApply: Filled near text "${text}" with "${value.substring(0, 30)}..."`);
        return true;
      }
    }

    return false;
  }

  function fillSelect(labelTexts, value) {
    // Find select elements by nearby label text
    const selects = document.querySelectorAll("select");
    for (const select of selects) {
      const label = getFieldLabel(select).toLowerCase();
      if (!labelTexts.some((t) => label.includes(t))) continue;

      // Find the best matching option
      const options = Array.from(select.options);
      const match = options.find((o) =>
        o.text.toLowerCase().includes(value.toLowerCase()) ||
        o.value.toLowerCase().includes(value.toLowerCase())
      );

      if (match) {
        select.value = match.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        console.log(`AutoApply: Set select "${label}" to "${match.text}"`);
        return true;
      }
    }

    // Also try custom dropdown buttons (Greenhouse uses these)
    const buttons = document.querySelectorAll('[role="listbox"], [role="combobox"], [class*="select"]');
    for (const btn of buttons) {
      const label = getFieldLabel(btn).toLowerCase();
      if (labelTexts.some((t) => label.includes(t))) {
        console.log(`AutoApply: Found custom dropdown "${label}" — needs manual selection for "${value}"`);
      }
    }

    return false;
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

  /* ─────────────── UI BANNER ─────────────── */

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
    if (type === "success") setTimeout(() => { if (banner) banner.remove(); }, 20000);
    if (type === "error") setTimeout(() => { if (banner) banner.remove(); }, 20000);
  }
})();
