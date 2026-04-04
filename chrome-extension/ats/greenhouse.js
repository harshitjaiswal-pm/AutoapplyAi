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

    for (const { labels, value } of labelFields) {
      if (value && fillByLabel(labels, value)) filled++;
    }

    // ── Select / dropdown fields (handled async after text fields) ──
    // Greenhouse uses React Select — needs click simulation, not native select API
    const dropdownFields = [
      { labels: ["pronouns"],                                                  value: user.pronouns || "He/Him" },
      { labels: ["sponsorship", "immigration", "require immigration"],         value: user.requireSponsorship === "No" ? "No" : (user.requireSponsorship || "No") },
      { labels: ["state", "province", "reside in"],                           value: user.province || "Ontario" },
      { labels: ["how did you", "hear about", "learn about", "first learn"],  value: user.howDidYouHear || "LinkedIn" },
      { labels: ["gender"],                                                    value: user.gender },
      { labels: ["race", "ethnicity"],                                         value: user.ethnicity },
      { labels: ["veteran"],                                                   value: user.veteranStatus },
      { labels: ["disability"],                                                value: user.disabilityStatus },
      { labels: ["previously been employed", "worked here", "employed at"],   value: "I have not previously" },
    ];

    // Fill dropdowns sequentially with delays (React Select needs time to open/close)
    (async () => {
      for (const { labels, value } of dropdownFields) {
        if (value) {
          await fillReactSelect(labels, value);
          // Extra pause between dropdowns to let React settle
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      console.log("AutoApply: Finished filling dropdowns");
    })();

    // ── Cover letter ──
    // Only fill textareas explicitly labeled as cover letter — NOT "Other Links" or generic fields
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
      // Note: Greenhouse cover letter is typically a file upload, not a textarea.
      // The tailored cover letter will be downloaded as part of the resume PDF.
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

  /**
   * Fill a Greenhouse React Select dropdown.
   *
   * THREE strategies tried in order:
   *   1. Native <select> element
   *   2. React Select via keyboard (type to search + Enter) — most reliable
   *   3. React Select via click (fallback)
   *
   * The keyboard approach works because React Select has a hidden <input>
   * inside the control. Focusing it and typing filters the options list,
   * then Enter selects the first match. This avoids fragile DOM traversal.
   */
  async function fillReactSelect(labelTexts, value) {
    if (!value) return false;
    const valueLower = value.toLowerCase();

    console.log(`AutoApply: Trying to fill dropdown for [${labelTexts.join(", ")}] with "${value}"`);

    // ── Strategy 1: native <select> ──
    const selects = document.querySelectorAll("select");
    for (const select of selects) {
      const label = getFieldLabel(select).toLowerCase();
      if (!labelTexts.some((t) => label.includes(t))) continue;
      const options = Array.from(select.options);
      const match =
        options.find((o) => o.text.toLowerCase() === valueLower) ||
        options.find((o) => o.text.toLowerCase().includes(valueLower)) ||
        options.find((o) => valueLower.includes(o.text.toLowerCase()) && o.text.length > 3);
      if (match) {
        select.value = match.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        console.log(`AutoApply: [native select] "${label}" -> "${match.text}"`);
        return true;
      }
    }

    // ── Strategy 2 & 3: React Select ──
    // First, find the React Select container associated with this label.
    // Walk from label → up through ancestors → look for the select control.
    const matchedControl = findReactSelectForLabel(labelTexts);
    if (!matchedControl) {
      console.log(`AutoApply: No React Select found for [${labelTexts.join(", ")}]`);
      return false;
    }

    const { control, labelText } = matchedControl;

    // ── Strategy 2: Keyboard approach (most reliable) ──
    // React Select always has an input inside — focus it, type, pick.
    const hiddenInput = control.querySelector("input");
    if (hiddenInput) {
      console.log(`AutoApply: [keyboard] Focusing input for "${labelText}"`);
      hiddenInput.focus();
      await new Promise((r) => setTimeout(r, 200));

      // Clear any existing value first
      hiddenInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));

      // Type the search value character by character
      // Use a short search term (first meaningful word) for better matching
      const searchTerm = getSearchTerm(value);
      console.log(`AutoApply: [keyboard] Typing search: "${searchTerm}" for "${labelText}"`);

      for (const char of searchTerm) {
        hiddenInput.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
        hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
        // React Select uses inputChange internally, we need to set the value
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(hiddenInput, hiddenInput.value + char);
        } else {
          hiddenInput.value += char;
        }
        hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
        hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 50));
      }

      // Wait for filtered options to appear
      await new Promise((r) => setTimeout(r, 500));

      // Check if a menu appeared with matching options
      const menu = document.querySelector('[class*="menu-list"], [class*="menuList"], [class*="select__menu"]');
      if (menu) {
        const options = menu.querySelectorAll('[class*="option"], [role="option"]');
        console.log(`AutoApply: [keyboard] "${labelText}" showing ${options.length} filtered options`);

        // Find best match
        const picked = pickBestOption(options, valueLower, labelText);
        if (picked) {
          // Close and move on
          await new Promise((r) => setTimeout(r, 300));
          return true;
        }
      }

      // If typing didn't work, close with Escape and try click approach
      hiddenInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    }

    // ── Strategy 3: Click to open menu, then click the option ──
    console.log(`AutoApply: [click] Opening dropdown for "${labelText}"`);

    // Try multiple click approaches — Greenhouse React Select needs mousedown
    const clickTarget = control.querySelector('[class*="indicator"]') || control;
    clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // Also try clicking the control itself if indicator didn't work
    if (clickTarget !== control) {
      await new Promise((r) => setTimeout(r, 200));
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }

    await new Promise((r) => setTimeout(r, 800));

    // Look for the menu anywhere in the document
    const menu =
      document.querySelector('[class*="select__menu-list"]') ||
      document.querySelector('[class*="menu-list"]') ||
      document.querySelector('[class*="menuList"]') ||
      document.querySelector('[class*="select__menu"]');

    if (!menu) {
      console.log(`AutoApply: [click] Menu did not open for "${labelText}"`);

      // Last resort: dump the control's HTML for debugging
      console.log(`AutoApply: [debug] Control classes: ${control.className}`);
      console.log(`AutoApply: [debug] Control children: ${control.children.length}`);
      for (const child of control.children) {
        console.log(`AutoApply: [debug]   child: ${child.tagName} class="${child.className?.substring?.(0, 60)}"`);
      }

      document.body.click();
      await new Promise((r) => setTimeout(r, 200));
      return false;
    }

    const opts = menu.querySelectorAll('[class*="option"], [role="option"]');
    console.log(`AutoApply: [click] "${labelText}" has ${opts.length} options`);

    const picked = pickBestOption(opts, valueLower, labelText);

    if (!picked) {
      console.log(`AutoApply: [click] No match for "${value}" in "${labelText}". Options: ` +
        Array.from(opts).map((o) => o.textContent?.trim()).join(" | "));
      document.body.click();
      await new Promise((r) => setTimeout(r, 200));
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }

    return picked;
  }

  /**
   * Find the React Select control element associated with a set of label texts.
   * Uses multiple search strategies since Greenhouse DOM varies per form.
   */
  function findReactSelectForLabel(labelTexts) {
    // Approach A: Walk from <label> elements upward to find the React Select
    const allLabels = document.querySelectorAll("label");
    for (const labelEl of allLabels) {
      const labelText = (labelEl.textContent || "").trim().toLowerCase().replace(/\s*\*\s*$/, "");
      if (!labelTexts.some((t) => labelText.includes(t))) continue;

      // Walk up through multiple levels of ancestors looking for the select control
      let node = labelEl;
      for (let i = 0; i < 6; i++) {
        node = node.parentElement;
        if (!node) break;
        const control = node.querySelector(
          '[class*="select__control"], [class*="Select__control"], [class*="selectControl"]'
        );
        if (control) {
          console.log(`AutoApply: Found React Select at ancestor level ${i + 1} for "${labelText}"`);
          return { control, labelText };
        }
      }

      // Also check label's next siblings and their children
      let sibling = labelEl.nextElementSibling;
      for (let i = 0; i < 3 && sibling; i++) {
        const control = sibling.querySelector?.(
          '[class*="select__control"], [class*="Select__control"]'
        ) || (sibling.className?.includes?.("select__control") ? sibling : null);
        if (control) {
          console.log(`AutoApply: Found React Select as sibling ${i + 1} of label "${labelText}"`);
          return { control, labelText };
        }
        sibling = sibling.nextElementSibling;
      }

      // Check parent's next sibling (common pattern: label is in one div, select in next)
      const parentSibling = labelEl.parentElement?.nextElementSibling;
      if (parentSibling) {
        const control = parentSibling.querySelector?.(
          '[class*="select__control"], [class*="Select__control"]'
        );
        if (control) {
          console.log(`AutoApply: Found React Select as parent's sibling for "${labelText}"`);
          return { control, labelText };
        }
      }

      console.log(`AutoApply: Label "${labelText}" found but no React Select nearby`);
    }

    // Approach B: Find all React Select controls, then match each to its nearest label
    const allControls = document.querySelectorAll(
      '[class*="select__control"], [class*="Select__control"]'
    );
    console.log(`AutoApply: Found ${allControls.length} React Select controls on page`);

    for (const control of allControls) {
      // Walk up to find the nearest label text
      let node = control;
      for (let i = 0; i < 6; i++) {
        node = node.parentElement;
        if (!node) break;
        const label = node.querySelector("label");
        if (label) {
          const labelText = (label.textContent || "").trim().toLowerCase().replace(/\s*\*\s*$/, "");
          if (labelTexts.some((t) => labelText.includes(t))) {
            console.log(`AutoApply: [reverse] Matched control to label "${labelText}"`);
            return { control, labelText };
          }
        }
      }
    }

    return null;
  }

  /**
   * Click the best matching option from a list of React Select option elements.
   */
  function pickBestOption(options, valueLower, labelText) {
    // Try exact match first, then partial
    let match = null;
    for (const opt of options) {
      const optText = (opt.textContent || "").trim().toLowerCase();
      if (optText === valueLower) { match = opt; break; }
    }
    if (!match) {
      for (const opt of options) {
        const optText = (opt.textContent || "").trim().toLowerCase();
        if (optText.includes(valueLower) || valueLower.includes(optText) && optText.length > 2) {
          match = opt;
          break;
        }
      }
    }
    // For yes/no dropdowns, also match "I do not" patterns
    if (!match && (valueLower === "no" || valueLower === "yes")) {
      for (const opt of options) {
        const optText = (opt.textContent || "").trim().toLowerCase();
        if (valueLower === "no" && (optText.includes("do not") || optText.includes("not") || optText.startsWith("no"))) {
          match = opt;
          break;
        }
        if (valueLower === "yes" && (optText.startsWith("yes") || (!optText.includes("not") && !optText.includes("no")))) {
          // Skip — too ambiguous for "yes"
        }
      }
    }

    if (match) {
      console.log(`AutoApply: Picking "${match.textContent?.trim()}" for "${labelText}"`);
      match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      match.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  }

  /**
   * Get a good search term for React Select type-to-search.
   * Use the first meaningful word, or a short substring.
   */
  function getSearchTerm(value) {
    // For short values, use the whole thing
    if (value.length <= 8) return value;
    // For "He/Him", "She/Her" etc, use the first part
    if (value.includes("/")) return value.split("/")[0];
    // For multi-word, find the longest word that's >= 4 chars (skip articles)
    const words = value.split(/\s+/);
    const skipWords = ["i", "a", "an", "the", "have", "has", "do", "not", "am", "is", "are", "was", "been"];
    const meaningful = words.find((w) => w.length >= 4 && !skipWords.includes(w.toLowerCase()));
    if (meaningful) return meaningful;
    // For multi-word, use first word unless it's very short
    if (words[0].length >= 3) return words[0];
    // Return first 10 chars
    return value.substring(0, 10);
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
