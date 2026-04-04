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
    showBanner("AutoApply: Preparing application...");

    try {
      // Try to scrape JD from whatever page we're on
      const pageJD = scrapeGenericJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      if (!jobDescription || jobDescription.length < 30) {
        showBanner("AutoApply: No job description found. Filling basic info only...", "info");
      }

      showBanner("AutoApply: Tailoring your resume (this may take 15-30s)...");

      // Send to background with a timeout
      const tailoredData = await sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 60000); // 60 second timeout

      if (tailoredData?.error) {
        console.error("AutoApply: Tailoring error:", tailoredData.error);
        showBanner(`AutoApply: ${tailoredData.error}`, "error");
        // Still try to fill basic profile info
        await fillBasicProfile();
        return;
      }

      if (!tailoredData?.tailoredResult) {
        showBanner("AutoApply: Tailoring returned no data. Filling basic info...", "error");
        await fillBasicProfile();
        return;
      }

      showBanner("AutoApply: Filling form fields...");
      console.log("AutoApply: Got tailored result, match score:", tailoredData.matchScore);

      await fillGenericForm(tailoredData.tailoredResult, pendingJob);

      // Request resume PDF download
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      showBanner(
        "AutoApply: Fields filled! Upload the downloaded resume PDF and review before submitting.",
        "success"
      );
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Generic ATS error", err);
      showBanner(`AutoApply: Error — ${err.message}. Filling basic info...`, "error");
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
      showBanner("AutoApply: No profile data found. Sync your profile from the pipeline page.", "error");
      return;
    }

    const fieldMappings = [
      { labels: ["first name", "given name", "prénom"], value: user.firstName },
      { labels: ["last name", "family name", "surname", "nom"], value: user.lastName },
      { labels: ["email", "e-mail", "email address"], value: user.email },
      { labels: ["phone", "telephone", "mobile", "phone number"], value: user.phone },
      { labels: ["linkedin", "linkedin url", "linkedin profile"], value: user.linkedin },
    ];

    let filled = 0;
    for (const mapping of fieldMappings) {
      if (!mapping.value) continue;
      if (fillByLabel(mapping.labels, mapping.value)) filled++;
    }

    // Try full name field
    if (user.firstName && user.lastName) {
      if (fillByLabel(["full name", "your name"], `${user.firstName} ${user.lastName}`)) filled++;
    }

    if (filled > 0) {
      showBanner(`AutoApply: Filled ${filled} fields with your profile info. Complete the rest manually.`, "success");
    }
  }

  async function fillGenericForm(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    console.log("AutoApply: User profile:", JSON.stringify(user));

    // Field mappings — order matters (specific first)
    const fieldMappings = [
      { labels: ["first name", "given name", "prénom"], value: user.firstName },
      { labels: ["last name", "family name", "surname", "nom"], value: user.lastName },
      { labels: ["email", "e-mail", "email address"], value: user.email },
      { labels: ["phone", "telephone", "mobile", "phone number"], value: user.phone },
      { labels: ["linkedin", "linkedin url", "linkedin profile"], value: user.linkedin },
    ];

    let filled = 0;
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

    // Try to fill "full name" field (only if we didn't fill first/last separately)
    if (user.firstName && user.lastName) {
      fillByLabel(["full name", "your name"], `${user.firstName} ${user.lastName}`);
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
    if (type === "success") setTimeout(() => { if (banner) banner.remove(); }, 15000);
    if (type === "error") setTimeout(() => { if (banner) banner.remove(); }, 20000);
  }
})();
