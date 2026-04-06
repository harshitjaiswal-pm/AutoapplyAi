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

  // Show banner immediately so the user knows AutoApply is active on this page
  showBanner("AutoApply is starting...", "ai", { subtext: "Waiting for page to finish loading..." });
  setTimeout(() => init(), 3000);

  /* ─────────────── FORM VS POSTING DETECTION ─────────────── */

  /**
   * Returns true if the current page looks like an application form.
   * Covers: standard forms, Ashby tab-based forms, iframes with forms.
   */
  /**
   * Returns true only when a VISIBLE application form is currently showing.
   * Key subtlety: Ashby renders both Overview and Application tab content in the DOM
   * simultaneously — we must only count VISIBLE inputs to avoid false positives when
   * the Application tab is inactive.
   */
  function isOnApplicationForm() {
    // ── Ashby-specific: "Type here..." placeholder is unique to Ashby form inputs ──
    const ashbyInputs = document.querySelectorAll('input[placeholder*="here" i], input[placeholder*="type" i]');
    if (ashbyInputs.length > 0) return true;

    // ── Ashby-specific: look for "Application Details" in ANY element (not just headings) ──
    // Ashby uses custom-styled divs, not semantic h-tags, for section headers.
    const allEls = document.querySelectorAll('p, div, span, strong, h1, h2, h3, h4, h5, h6, section');
    for (const el of allEls) {
      if (el.children.length > 3) continue; // skip layout containers
      const text = (el.textContent || "").trim().toLowerCase();
      if (text === "application details" || text === "application form" ||
          text.startsWith("application details")) {
        const style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden") return true;
      }
    }

    // ── Labels with common first-field names (reliable form signal) ──
    const labels = document.querySelectorAll("label");
    for (const lbl of labels) {
      const text = (lbl.textContent || "").replace(/\*/g, "").trim().toLowerCase();
      if (text === "full name" || text === "first name" || text === "email" ||
          text === "email address" || text === "phone" || text === "resume") {
        const style = window.getComputedStyle(lbl);
        if (style.display !== "none" && style.visibility !== "hidden") return true;
      }
    }

    // ── Visible non-hidden inputs (2+ required) — only check display/visibility, not rect ──
    // getBoundingClientRect can return zeros during CSS transitions (Ashby has tab animations)
    const allInputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])' +
      ':not([type="file"]):not([type="submit"]):not([type="button"])' +
      ':not([type="reset"]):not([type="image"]):not([type="range"]):not([type="color"]), textarea'
    );
    let visibleCount = 0;
    for (const el of allInputs) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      visibleCount++;
      if (visibleCount >= 2) return true;
    }

    // ── Explicit <form> with visible inputs ──
    const forms = document.querySelectorAll("form");
    for (const f of forms) {
      const style = window.getComputedStyle(f);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (f.querySelector("input:not([type='hidden']), textarea, select")) return true;
    }

    // ── Ashby iframe embed ──
    const frames = document.querySelectorAll("iframe");
    for (const fr of frames) {
      try {
        const doc = fr.contentDocument || fr.contentWindow?.document;
        if (doc && doc.querySelector('input:not([type="hidden"]), textarea')) return true;
      } catch (_) { /* cross-origin */ }
    }

    return false;
  }

  /**
   * Ashby-specific form readiness check.
   * Polls for Ashby's characteristic signals: "Type here..." placeholders,
   * "Full Name" labels, or "Application Details" heading in any element.
   * Much more reliable than the generic isOnApplicationForm() for Ashby pages.
   */
  async function waitForAshbyForm(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Signal 1: Ashby's "Type here..." placeholder is the most specific indicator
      if (document.querySelector('input[placeholder*="here" i], input[placeholder*="type" i]')) return true;

      // Signal 2: "Application Details" heading in any element
      const allEls = document.querySelectorAll('p, div, span, strong, h1, h2, h3, h4');
      for (const el of allEls) {
        if (el.children.length > 3) continue;
        const text = (el.textContent || "").trim().toLowerCase();
        if (text === "application details" || text.startsWith("application details")) {
          const style = window.getComputedStyle(el);
          if (style.display !== "none" && style.visibility !== "hidden") return true;
        }
      }

      // Signal 3: A "Full Name" or "Email" label is visible
      const labels = document.querySelectorAll("label");
      for (const lbl of labels) {
        const text = (lbl.textContent || "").replace(/\*/g, "").trim().toLowerCase();
        if (text === "full name" || text === "first name" || text === "email" || text === "email address") {
          const style = window.getComputedStyle(lbl);
          if (style.display !== "none" && style.visibility !== "hidden") return true;
        }
      }

      // Signal 4: 2+ inputs with no display:none / visibility:hidden (ignores rect during transitions)
      const inputs = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])' +
        ':not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea'
      );
      let cnt = 0;
      for (const el of inputs) {
        const s = window.getComputedStyle(el);
        if (s.display !== "none" && s.visibility !== "hidden") { cnt++; if (cnt >= 2) return true; }
      }

      await sleep(400);
    }
    return false;
  }

  /**
   * Find and click the apply / start-application button on a job posting page.
   * Covers ALL known variants across Ashby, Greenhouse custom, Lever custom,
   * iCIMS, Workable, SmartRecruiters, BambooHR, and generic career pages.
   * Returns true if a button was clicked.
   */
  async function clickApplyOnPosting() {
    // ── Exact & high-confidence matches (checked first) ──────────────────────
    const exactMatches = new Set([
      "apply", "apply now", "apply today", "apply here",
      "apply for this job", "apply for this role", "apply for this position",
      "apply for job", "apply for role", "apply for position",
      "apply to this job", "apply to this role", "apply to this position",
      "apply with linkedin", "apply externally",
      "i'm interested", "im interested", "i am interested",
      "interested in this role", "express interest",
      "start application", "start my application", "begin application",
      "submit application", "submit your application",
      "apply for opening", "apply to opening",
      "apply online", "apply via website",
    ]);

    // ── Scroll the full page first so off-screen buttons become reachable ──
    await scrollPageToFindApplyButton();

    // Exclude elements inside nav/header — avoids clicking site navigation links
    const candidates = Array.from(document.querySelectorAll('a[href], button, [role="button"]'))
      .filter(el => !el.closest('nav, header, [role="navigation"], [class*="navbar"], [class*="site-header"]'));

    // Pass 1: exact text match
    for (const el of candidates) {
      const text = (el.textContent?.trim() || "").toLowerCase().replace(/\s+/g, " ");
      if (exactMatches.has(text)) {
        console.log("AutoApply: Clicking exact Apply button:", el.textContent?.trim());
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(300);
        el.click();
        return true;
      }
    }

    // Pass 2: starts-with "apply" or "start application" (catches "Apply for Senior PM")
    for (const el of candidates) {
      const text = (el.textContent?.trim() || "").toLowerCase();
      if (text.startsWith("apply") || text.startsWith("start application") ||
          text.startsWith("i'm interested") || text.startsWith("im interested")) {
        console.log("AutoApply: Clicking prefix Apply button:", el.textContent?.trim());
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(300);
        el.click();
        return true;
      }
    }

    // Pass 3: Ashby "Application" tab — click it to reveal the form
    // But DON'T re-click if it's already active (would cause React remount)
    const tabs = document.querySelectorAll('[role="tab"], [class*="tab"]');
    for (const tab of tabs) {
      const text = (tab.textContent || "").trim().toLowerCase();
      if (text === "application" || text === "apply" || text === "application form") {
        const alreadyActive =
          tab.getAttribute("aria-selected") === "true" ||
          tab.getAttribute("aria-current") === "true" ||
          tab.classList.contains("active") ||
          tab.classList.contains("selected");
        if (alreadyActive) {
          console.log("AutoApply: Application tab already active — no click needed");
          return true; // form should already be showing
        }
        console.log("AutoApply: Clicking Ashby/tab Application tab:", tab.textContent?.trim());
        tab.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(300);
        tab.click();
        return true;
      }
    }

    // Pass 4: aria-label contains apply variants
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("apply") || label.includes("application")) {
        console.log("AutoApply: Clicking aria-label Apply button:", el.getAttribute("aria-label"));
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(300);
        el.click();
        return true;
      }
    }

    return false;
  }

  /**
   * Scroll the page slowly to the bottom so lazily-rendered Apply buttons
   * and forms become visible in the DOM before we query for them.
   */
  async function scrollPageToFindApplyButton() {
    const totalHeight = document.body.scrollHeight;
    const step = Math.min(600, totalHeight / 6);
    let pos = window.scrollY;

    while (pos < totalHeight) {
      pos += step;
      window.scrollTo({ top: pos, behavior: "smooth" });
      await sleep(300);

      // Early-exit: found a form or apply button already
      if (isOnApplicationForm()) return;
      const quick = Array.from(document.querySelectorAll('a[href], button, [role="button"]'))
        .some(el => (el.textContent?.trim() || "").toLowerCase().startsWith("apply") ||
                    (el.textContent?.trim() || "").toLowerCase().includes("i'm interested"));
      if (quick) return;
    }
    // Do NOT scroll back to top — on SPAs (Ashby, Lever custom, etc.) this
    // triggers router navigation and kills the content script.
  }

  /**
   * Find the "Application" tab on Ashby-embedded pages and click it if not already active.
   * Does NOT scroll the page — safe to call on SPAs.
   * Returns true if the tab was found (whether clicked or already active).
   */
  async function activateAshbyTab() {
    const tabSelectors = [
      '[role="tab"]',
      '[class*="tab"]',
      'button',
      'a',
    ];

    for (const sel of tabSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (text === "application" || text === "apply" || text === "application form") {
          const alreadyActive =
            el.getAttribute("aria-selected") === "true" ||
            el.getAttribute("aria-current") === "true" ||
            el.classList.contains("active") ||
            el.classList.contains("selected");

          if (alreadyActive) {
            console.log("AutoApply: Ashby Application tab already active");
            return true; // form should already be showing
          }

          console.log("AutoApply: Clicking Ashby Application tab:", el.textContent?.trim());
          el.click();
          await sleep(600); // give React time to render the form
          return true;
        }
      }
    }

    console.log("AutoApply: Could not find Ashby Application tab");
    return false;
  }

  /**
   * Wait until the page transitions to an application form,
   * or until the timeout elapses. Returns true if form found.
   */
  async function waitForApplicationForm(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isOnApplicationForm()) return true;
      await sleep(600);
    }
    return false;
  }

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing generic application for", pendingJob.jobTitle);
    showBanner("Opening application...", "ai");

    // Detect Ashby embedded pages — different strategy (no scrolling)
    const isAshbyPage =
      window.location.href.includes("ashby_jid=") ||
      window.location.href.includes("ashbyhq.com");

    // ── Fire tailoring immediately in the background ──
    // We don't wait for it here — form fills happen in parallel so there's no
    // visible delay. We only await the result when we need it for resume upload.
    const pageJD = scrapeGenericJD();
    const jobDescription = pageJD || pendingJob.jobDescription;
    const tailoringPromise = sendMessageWithTimeout({
      type: "TAILOR_AND_FILL",
      job: { ...pendingJob, jobDescription },
    }, 90000).then(r => { if (r?.error) console.error("AutoApply: Tailoring error:", r.error); return r; })
             .catch(err => { console.error("AutoApply: Tailoring failed:", err.message); return null; });

    try {
      // ── Step 0: Navigate to the application form ──
      if (isAshbyPage) {
        // Ashby uses non-standard rendering (contenteditable, custom placeholders, etc.)
        // Detection via querySelector is unreliable — skip it and go straight to fill.
        showBanner("Opening application form...", "ai", { subtext: "Tailoring resume in background..." });

        // Ensure Application tab is active
        await activateAshbyTab();

        // Fixed wait — let React fully render after tab switch
        await sleep(2500);

        // No detection gate. Fall straight through to filling.
        // fillAshbyForm() uses a broad multi-strategy approach that handles
        // contenteditable, role=textbox, aria-placeholder, and standard inputs.
      } else if (!isOnApplicationForm()) {
        // Generic non-Ashby page: scroll and find Apply button
        showBanner("Opening application form...", "ai", { subtext: "Tailoring resume in background..." });
        const clicked = await clickApplyOnPosting();
        if (!clicked) {
          showBanner("Click the Apply button to open the application form.", "user",
            { subtext: "AutoApply will detect the form and continue automatically." });
        } else {
          showBanner("Waiting for application form to load...", "ai",
            { subtext: "Tailoring resume in background..." });
        }
        const formReady = await waitForApplicationForm(20000);
        if (!formReady) {
          showBanner("Could not detect application form — please navigate to it manually.", "user");
          return;
        }
        await sleep(500);
      }

      // ── Step 1: Fill basic fields immediately (no tailoring needed) ──
      showBanner("Filling your details...", "ai", { subtext: "Tailoring resume in background..." });
      const basicFilled = await fillBasicProfile();

      if (basicFilled === 0 && isAshbyPage) {
        // Nothing was filled — Ashby may be using non-standard elements.
        // Log what's in the DOM to help debug.
        const inputCount = document.querySelectorAll('input:not([type="hidden"])').length;
        const labelCount = document.querySelectorAll('label').length;
        const editableCount = document.querySelectorAll('[contenteditable], [role="textbox"]').length;
        console.warn(`AutoApply: 0 fields filled on Ashby page. DOM has: ${inputCount} inputs, ${labelCount} labels, ${editableCount} contenteditable/textbox elements`);
        console.warn("AutoApply: Page HTML snippet:", document.body.innerHTML.substring(0, 2000));
      }

      // ── Step 2: Await tailoring result for additional fields + resume upload ──
      showBanner("Completing fields with tailored data...", "ai", { subtext: "Almost ready..." });
      const tailoredData = await tailoringPromise;

      if (tailoredData?.tailoredResult) {
        console.log("AutoApply: Got tailored result, filling additional fields...");
        await fillGenericForm(tailoredData.tailoredResult, pendingJob);
      } else {
        console.warn("AutoApply: No tailored data — basic profile already filled");
      }

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
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
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
      { labels: ["preferred name", "nickname", "display name", "what should we call you"], value: user.preferredName || user.firstName },
      { labels: ["pronouns", "pronoun", "preferred pronoun"], value: user.pronouns },
    ];

    for (const mapping of otherMappings) {
      if (!mapping.value) continue;
      if (fillByLabel(mapping.labels, mapping.value)) filled++;
    }

    if (filled > 0) {
      showBanner(`Filled ${filled} fields — complete the rest manually and submit when ready.`, "user");
    }
    return filled;
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
      const labelText = (label.textContent || "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
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
      const text = (textEl.textContent || "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
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

      // Also check for contenteditable or role=textbox (Ashby, Draft.js, rich-text fields)
      const editable = parent.querySelector('[contenteditable="true"], [contenteditable=""], [role="textbox"]');
      if (editable && !editable.textContent.trim()) {
        console.log(`AutoApply: Filling contenteditable near "${text}" with "${value.substring(0, 20)}..."`);
        setEditableValue(editable, value);
        return true;
      }
    }

    // Strategy 4: aria-placeholder attribute (Ashby and other accessible form libs)
    const ariaPlaceholders = document.querySelectorAll('[aria-placeholder], [placeholder]');
    for (const el of ariaPlaceholders) {
      const phText = (el.getAttribute("aria-placeholder") || el.getAttribute("placeholder") || "").toLowerCase();
      if (labelTexts.some(t => phText.includes(t))) {
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          if (!el.value) { setNativeValue(el, value); return true; }
        } else if (el.contentEditable === "true" || el.getAttribute("role") === "textbox") {
          if (!el.textContent.trim()) { setEditableValue(el, value); return true; }
        }
      }
    }

    return false;
  }

  /**
   * Set value on a contenteditable or role=textbox element.
   * Used for Ashby and other form frameworks that don't use native <input>.
   */
  function setEditableValue(element, value) {
    element.focus();
    // Clear and set via execCommand (works across most frameworks)
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, value);
    // Also set textContent as fallback and fire events
    if (!element.textContent.trim()) {
      element.textContent = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
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
        ? `<span id="aa-elapsed-timer" style="font-size:14px;font-weight:700;opacity:0.9;margin-left:auto;font-variant-numeric:tabular-nums;letter-spacing:1px;background:rgba(0,0,0,0.18);border-radius:5px;padding:1px 8px;">0:00</span>`
        : "";

      const subtextRow = opts.subtext
        ? `<div style="font-size:11px;opacity:0.75;margin-top:3px;padding-left:2px;">${opts.subtext}</div>`
        : "";

      // ── Action buttons (error and user-turn states get quick actions)
      const btnStyle = `border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;`;
      let actionRow = "";
      if (type === "error") {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">🔄 Retry</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">⏭ Skip Job</button>
        </div>`;
      } else if (type === "user") {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">🔄 Try Again</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">⏭ Skip Job</button>
        </div>`;
      }

      banner.style.background = cfg.bg;
      banner.style.color = "#fff";
      banner.innerHTML = `
        <div style="padding:8px 18px 7px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${batchTag}${jobLabel}</div>
          ${progressBar}
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">${actorBadge}${statusMsg}${timerEl}</div>
          ${subtextRow}
          ${actionRow}
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

      // Wire up action buttons
      document.getElementById("aa-btn-retry")?.addEventListener("click", () => {
        banner.remove();
        window.__autoapply_ats_injected = false;
        setTimeout(() => init(), 500);
      });
      document.getElementById("aa-btn-skip")?.addEventListener("click", () => {
        chrome.storage.local.remove(["pendingApplication"]);
        showBanner("Job skipped. You can close this tab.", "success");
      });
    });

    if (type === "success") banner._dismissTimer = setTimeout(() => banner.remove(), 15000);
    if (type === "error")   banner._dismissTimer = setTimeout(() => banner.remove(), 20000);
  }
})();
