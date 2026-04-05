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

      // Attempt programmatic resume upload, fall back to download
      const uploaded = await attemptResumeUpload();
      if (!uploaded) {
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_RESUME",
          job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
        });
      }

      showBanner(
        uploaded
          ? "AutoApply: Form filled & resume uploaded! Review and submit."
          : "AutoApply: Fields filled! Upload the downloaded resume PDF and review before submitting.",
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
      showBanner(`AutoApply: Filled ${filled} fields with your profile info. Complete the rest manually.`, "success");
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

    if (type === "success") setTimeout(() => { if (banner) banner.remove(); }, 15000);
    if (type === "error") setTimeout(() => { if (banner) banner.remove(); }, 20000);
  }
})();
