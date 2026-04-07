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

  // ── Cross-origin iframe detection ──
  // When boards.greenhouse.io is embedded as an iframe in a company career page
  // (e.g. asana.com/jobs/apply/...?gh_jid=...) the parent frame cannot access
  // this iframe's DOM. We handle filling independently here instead.
  const isChildFrame = (window !== window.top);
  if (isChildFrame) {
    try {
      // If same-origin parent, they can access us — skip to avoid double fill
      const _check = window.top.document;
      console.log("AutoApply: GH same-origin child frame — parent handles fill");
      return;
    } catch (e) {
      // Cross-origin parent — we must fill ourselves
    }
    console.log("AutoApply: GH cross-origin child frame — filling independently");
    (async () => {
      let stored = await chrome.storage.local.get(["pendingApplication", "userProfile"]);
      if (!stored.pendingApplication) {
        // Wait up to 60s for pendingApplication to be set
        await new Promise((resolve) => {
          const listener = (changes) => {
            if (changes.pendingApplication?.newValue) {
              chrome.storage.onChanged.removeListener(listener);
              resolve();
            }
          };
          chrome.storage.onChanged.addListener(listener);
          setTimeout(resolve, 60000);
        });
        stored = await chrome.storage.local.get(["pendingApplication", "userProfile"]);
      }
      if (!stored.pendingApplication) return;

      // Wait for the Greenhouse form to render in this iframe (up to 20s)
      const formReady = await waitForGreenhouseForm(20000);
      if (!formReady) {
        console.warn("AutoApply: GH child frame timed out waiting for form");
        return;
      }

      const user = stored.userProfile || {};
      fillAllFields(user, null);
      await attemptResumeUpload();
      console.log("AutoApply: GH child frame filled form");
    })();
    return; // don't run main init() flow
  }

  showBanner("AutoApply is starting...", "ai", { subtext: "Waiting for page to finish loading..." });
  setTimeout(() => init(), 1500);

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    // Remove pendingApplication immediately so any re-injection (SW restart) exits early
    chrome.storage.local.remove(["pendingApplication"]);
    console.log("AutoApply: Processing Greenhouse application for", pendingJob.jobTitle);
    showBanner("Preparing your application...", "ai");

    // ── Step 0: Navigate to the application form if we're on the posting page ──
    // job-boards.greenhouse.io/{co}/jobs/{id} shows the JD only — the actual
    // form is a click or navigation away. Detect this early and redirect so the
    // content script re-runs on the form page (still with pendingApplication set).
    if (!isOnGreenhouseApplicationForm()) {
      console.log("AutoApply: On Greenhouse posting page — navigating to application form");
      showBanner("Opening application form...", "ai", { subtext: "Navigating to the application..." });
      const navigated = await clickGreenhouseApplyButton();
      if (!navigated) {
        showBanner(
          "⚠️ Couldn't find the Apply button — please click it manually.",
          "user",
          { subtext: "Once on the application form, AutoApply will fill it automatically." }
        );
      }
      // Stop here — the page will navigate and the content script re-runs on the form
      return;
    }

    try {
      // Scrape JD from Greenhouse (more complete than LinkedIn)
      const pageJD = scrapeGreenhouseJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      // Store pay range in batch progress so banner can display it
      storeSalaryRangeInProgress(extractPayRangeFromJD(jobDescription));

      // ── STEP 1: Fill basic fields IMMEDIATELY — don't leave form empty ──
      showBanner("Filling your details...", "ai", { subtext: "Tailoring resume in background..." });
      await fillBasicFieldsOnly();

      // ── STEP 2: Fire tailoring as a background Promise ──
      showBanner("Tailoring your resume for this role...", "ai", {
        subtext: "Basic info filled ✓ — personalising resume now...",
      });
      const tailoringPromise = sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 90000).catch(err => ({ error: err.message }));

      // ── STEP 3: Wait for tailoring, then fill remaining fields ──
      const tailoredData = await tailoringPromise;

      if (tailoredData?.error) {
        console.error("AutoApply: Tailoring error:", tailoredData.error);
        showBanner("Tailoring had an issue — basic info already filled.", "error", { subtext: tailoredData.error });
        showBanner("Review remaining fields and submit.", "user", { subtext: "Some fields may need manual input." });
        return;
      }

      if (!tailoredData?.tailoredResult) {
        showBanner("Tailoring returned no data — basic info already filled.", "error");
        showBanner("Review remaining fields and submit.", "user", { subtext: "Some fields may need manual input." });
        return;
      }

      showBanner("Filling remaining fields with tailored content...", "ai");
      console.log("AutoApply: Got tailored result, filling Greenhouse form");

      // Fill all fields (cover letter, dropdowns, custom Q&A) with tailored data
      await fillGreenhouseForm(tailoredData.tailoredResult, pendingJob, jobDescription);

      // Attempt resume file upload
      await attemptResumeUpload();

      // Download tailored resume PDF
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      showBanner(
        "Fields filled — upload the downloaded resume PDF, then review and submit.",
        "user",
        { subtext: "AutoApply stops here — you stay in control of the final submit." }
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
      showBanner("Error filling form — filling basic info as fallback.", "error", { subtext: err.message });
      await fillBasicFieldsOnly();
      showBanner("Basic info filled — review remaining fields and submit.", "user", { subtext: "Some fields may need manual input." });
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

  /**
   * Extract the maximum base pay from a job description string.
   * Handles: $120,000–$190,000 / $120K–$190K / up to $190K / USD 190,000/yr etc.
   * Returns the max as a plain integer string (e.g. "190000"), or null if not found.
   */
  function extractMaxPayFromJD(jdText) {
    if (!jdText) return null;
    const text = jdText.replace(/,/g, ""); // strip commas: 190,000 → 190000
    const amounts = [];
    const re = /\$\s*(\d+(?:\.\d+)?)\s*([kK])?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let val = parseFloat(m[1]);
      if (m[2]) val *= 1000; // K suffix
      if (val >= 30000 && val <= 2000000) amounts.push(val); // sanity-check salary range
    }
    if (amounts.length === 0) return null;
    return String(Math.round(Math.max(...amounts)));
  }

  /** Formatted pay range for banner display, e.g. "$120K–$190K". */
  function extractPayRangeFromJD(jdText) {
    if (!jdText) return null;
    const text = jdText.replace(/,/g, "");
    const amounts = [];
    const re = /\$\s*(\d+(?:\.\d+)?)\s*([kK])?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let val = parseFloat(m[1]);
      if (m[2]) val *= 1000;
      if (val >= 30000 && val <= 2000000) amounts.push(val);
    }
    if (amounts.length === 0) return null;
    const fmt = n => n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    return min === max ? fmt(max) : `${fmt(min)}–${fmt(max)}`;
  }

  function storeSalaryRangeInProgress(salaryRange) {
    if (!salaryRange) return;
    chrome.storage.local.get(["_aa_batchProgress"], ({ _aa_batchProgress: bp }) => {
      if (bp) chrome.storage.local.set({ _aa_batchProgress: { ...bp, salaryRange } });
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

  /* ─────────────── FORM READINESS POLL ─────────────── */

  /**
   * Polls until the Greenhouse application form is visible in the current document.
   * Used by the child-frame flow to wait for the form to render before filling.
   */
  async function waitForGreenhouseForm(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isOnGreenhouseApplicationForm()) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  /* ─────────────── POSTING VS FORM DETECTION ─────────────── */

  /**
   * Returns true when the current page is the Greenhouse APPLICATION FORM
   * (has visible input fields). Returns false on the JOB POSTING page.
   *
   * Greenhouse patterns:
   *  - Posting:  job-boards.greenhouse.io/{co}/jobs/{id}
   *              boards.greenhouse.io/{co}/jobs/{id}
   *  - Form:     job-boards.greenhouse.io/{co}/jobs/{id}/application
   *              boards.greenhouse.io/{co}/jobs/{id} (same URL, form inlined after Apply click)
   */
  function isOnGreenhouseApplicationForm() {
    // URL signal: form URLs include /application or /applications
    if (/\/application(s)?(\/|$|\?)/i.test(window.location.href)) return true;

    // DOM signal: Greenhouse form has first_name / email inputs visible
    const formInputSelectors = [
      'input[id="first_name"]', 'input[id="last_name"]', 'input[id="email"]',
      'input[name*="first_name"]', 'input[name*="last_name"]', 'input[name*="email"]',
      'input[autocomplete="given-name"]', 'input[autocomplete="email"]',
    ];
    for (const sel of formInputSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return true;
    }

    // Greenhouse "Submit Application" button id
    const submitBtn = document.querySelector('#submit_app');
    if (submitBtn && submitBtn.offsetParent !== null) return true;

    return false;
  }

  /**
   * Finds and clicks the Apply button on a Greenhouse job posting page,
   * or falls back to direct URL construction.
   * Returns true if a navigation was triggered.
   */
  async function clickGreenhouseApplyButton() {
    // Search for the Apply button by visible text
    const allClickable = Array.from(document.querySelectorAll('button, a[href], [role="button"]'));
    for (const el of allClickable) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (text === 'apply' || text === 'apply for this job' ||
          text === 'apply now' || text === 'apply for position') {
        console.log("AutoApply: Clicking Greenhouse apply button:", el.textContent.trim());
        el.click();
        return true;
      }
    }

    // Fallback: navigate directly to the canonical application URL.
    // job-boards.greenhouse.io/{co}/jobs/{id}  →  /application
    const baseUrl = window.location.href.split('?')[0].replace(/\/$/, '');
    if (/\/jobs\/\d+$/.test(baseUrl)) {
      const formUrl = baseUrl + '/application';
      console.log("AutoApply: No Apply button found — navigating directly to:", formUrl);
      window.location.href = formUrl;
      return true;
    }

    return false;
  }

  /* ─────────────── FORM FILLING ─────────────── */

  async function fillBasicFieldsOnly() {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};
    if (!user.firstName && !user.email) {
      showBanner("No profile data found — sync your profile from the extension panel.", "error");
      return;
    }
    fillAllFields(user, null);
  }

  async function fillGreenhouseForm(tailoredResult, job, jobDescription) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};
    console.log("AutoApply: User profile keys:", Object.keys(user));
    fillAllFields(user, tailoredResult, jobDescription);
  }

  function fillAllFields(user, tailoredResult, jobDescription) {
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

    // ── Radio / checkbox questions (common in custom Greenhouse forms) ──
    // Match by question label text, then pick the best option.
    fillRadioCheckboxQuestions(user);

    // ── Free-text custom questions ──
    const customTextFields = [
      { labels: ["compensation", "salary", "salary expectation", "compensation expectation", "desired salary", "expected salary", "pay expectation"], value: extractMaxPayFromJD(jobDescription) || user.salaryExpectation || user.compensation || "" },
      { labels: ["start date", "earliest start", "when can you start"],                       value: user.startDate || "2 weeks notice" },
    ];
    for (const { labels, value } of customTextFields) {
      if (value) fillByLabel(labels, value);
    }

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
        // Re-run radio/custom text fills after React re-renders
        fillRadioCheckboxQuestions(user);
        for (const { labels, value } of customTextFields) {
          if (value) fillByLabel(labels, value, true);
        }
        console.log("AutoApply: Text fields re-filled");

        // Validate fields and log any empty ones
        validateFilledFields(user, tailoredResult);
      }, dropdownFillTimeMs);
    });

    console.log(`AutoApply: Initial fill of ${filled} fields completed`);
  }

  /* ─────────────── RADIO / CHECKBOX QUESTIONS ─────────────── */

  /**
   * Handle radio-button and checkbox questions that appear on custom Greenhouse forms.
   * Strategy: find the question container by label text, then pick the best option.
   */
  function fillRadioCheckboxQuestions(user) {
    // All labels on the page — look for question text
    const allLabels = document.querySelectorAll("label, legend, .field label, [class*='label']");

    // Years of experience questions — pick the highest bucket that fits
    const yearsOfExp = parseInt(user.yearsOfExperience || "9", 10);
    const expKeywords = ["years of experience", "years of product management", "years of pm", "years working"];

    for (const label of allLabels) {
      const text = (label.textContent || "").toLowerCase().trim();
      if (text.length > 200) continue;

      if (expKeywords.some(k => text.includes(k))) {
        // Find the container and pick the best radio/checkbox option
        const container = label.closest("fieldset") || label.closest("[class*='field']") || label.closest("div");
        if (!container) continue;
        const options = container.querySelectorAll("input[type='radio'], input[type='checkbox']");
        let bestOption = null;
        let bestValue = -1;
        for (const opt of options) {
          const optLabel = (opt.closest("label")?.textContent || document.querySelector(`label[for="${opt.id}"]`)?.textContent || opt.value || "").toLowerCase();
          // Extract the highest number from the option label (e.g. "3+ years" → 3)
          const nums = optLabel.match(/\d+/g);
          const optVal = nums ? Math.max(...nums.map(Number)) : 0;
          if (yearsOfExp >= optVal && optVal >= bestValue) {
            bestValue = optVal;
            bestOption = opt;
          }
        }
        if (bestOption && !bestOption.checked) {
          bestOption.click();
          console.log("AutoApply: Selected years-of-experience option:", bestOption.value);
        }
        continue;
      }

      // Yes/No questions — hybrid schedule, remote work, sponsorship, authorization, relocating
      if (text.includes("hybrid") || text.includes("work in office") || text.includes("on-site")) {
        const answer = user.canWorkHybrid === true ? "yes" : "no";
        answerYesNo(label, answer);
        continue;
      }

      // Work authorization — "legally authorized to work"
      if (text.includes("legally authorized") || text.includes("work authoriz") || text.includes("authorized to work")) {
        answerYesNo(label, "yes");
        continue;
      }

      // Visa sponsorship — "require visa sponsorship", "require sponsorship", "immigration"
      if (text.includes("visa sponsor") || text.includes("require sponsor") || text.includes("sponsorship") || text.includes("immigration sponsor")) {
        const answer = (user.requireSponsorship === "Yes") ? "yes" : "no";
        answerYesNo(label, answer);
        continue;
      }

      // Relocation — "open to relocating", "willing to relocate"
      if (text.includes("relocat")) {
        answerYesNo(label, "yes");
        continue;
      }

      // Live in / based in state lists — "do you live in X, Y, Z"
      if (text.includes("do you live in") || text.includes("based in") || text.includes("reside in")) {
        answerYesNo(label, "yes");
        continue;
      }
    }
  }

  /**
   * Click the Yes or No answer for a question.
   * Handles: native radio/checkbox inputs, pill-style <button> toggles,
   * and ARIA role="radio" elements — all common in Greenhouse custom questions.
   */
  function answerYesNo(labelEl, yesOrNo) {
    const container = labelEl.closest("fieldset") || labelEl.closest("[class*='field']") ||
                      labelEl.closest("[class*='question']") || labelEl.closest("div");
    if (!container) return;

    // 1. Native radio / checkbox inputs
    const radios = container.querySelectorAll("input[type='radio'], input[type='checkbox']");
    for (const r of radios) {
      const optText = (r.closest("label")?.textContent || document.querySelector(`label[for="${r.id}"]`)?.textContent || r.value || "").toLowerCase();
      if (optText.includes(yesOrNo)) {
        if (!r.checked) r.click();
        console.log("AutoApply: [radio] Answered →", yesOrNo);
        return;
      }
    }

    // 2. Pill-style <button> toggles (common in Greenhouse & Ashby custom questions)
    const buttons = container.querySelectorAll("button");
    for (const btn of buttons) {
      const btnText = (btn.textContent || "").toLowerCase().trim();
      if (btnText === yesOrNo || btnText.startsWith(yesOrNo)) {
        btn.click();
        console.log("AutoApply: [button-pill] Answered →", yesOrNo);
        return;
      }
    }

    // 3. ARIA role="radio" elements (some custom UI frameworks)
    const ariaRadios = container.querySelectorAll("[role='radio'], [role='option']");
    for (const el of ariaRadios) {
      const elText = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase().trim();
      if (elText.includes(yesOrNo)) {
        el.click();
        console.log("AutoApply: [aria-radio] Answered →", yesOrNo);
        return;
      }
    }

    console.log("AutoApply: answerYesNo — no clickable element found for", yesOrNo, "in", labelEl.textContent?.trim());
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
      const ownerDoc = element.ownerDocument || document;
      const label = ownerDoc.querySelector(`label[for="${id}"]`);
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

    chrome.storage.local.get(["_aa_batchProgress", "tailoredResumePdf"], (result) => {
      const bp = result._aa_batchProgress;
      const hasBatch = bp && bp.total > 0;
      const hasPdf = !!result.tailoredResumePdf;

      const batchTag = hasBatch
        ? `<span style="background:rgba(255,255,255,0.18);border-radius:6px;padding:2px 10px;font-size:13px;font-weight:700;white-space:nowrap;">Job ${bp.current} / ${bp.total}</span>`
        : "";
      const pillStyle = `font-size:12px;opacity:0.9;background:rgba(255,255,255,0.15);border-radius:5px;padding:2px 8px;white-space:nowrap;`;
      const companyTag = (hasBatch && bp.company)
        ? `<span style="${pillStyle}">${bp.company}</span>` : "";
      const roleTag = (hasBatch && bp.title)
        ? `<span style="${pillStyle}">${bp.title}</span>` : "";
      const salaryTag = (hasBatch && bp.salaryRange)
        ? `<span style="${pillStyle}">💰 ${bp.salaryRange}</span>` : "";

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

      // Resume download button — always shown when PDF is ready
      const pdfBtnStyle = `border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;background:#fff;color:#4F46E5;`;
      const pdfBtn = hasPdf
        ? `<button id="aa-btn-download-resume" style="${pdfBtnStyle}">⬇️ Resume</button>`
        : "";

      const btnStyle = `border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;`;
      const pauseBtn = isAi
        ? `<button id="aa-btn-pause" style="${btnStyle}background:rgba(255,255,255,0.2);color:#fff;">⏸ Pause</button>`
        : "";
      const resumeBtn = opts.showResume
        ? `<button id="aa-btn-resume" style="${btnStyle}background:rgba(255,255,255,0.9);color:#B45309;">▶ Resume</button>`
        : "";
      let actionRow = "";
      if (type === "error") {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">🔄 Retry</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">⏭ Skip Job</button>
          ${pdfBtn}
        </div>`;
      } else if (type === "user") {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">🔄 Try Again</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">⏭ Skip Job</button>
          ${pdfBtn}
        </div>`;
      } else if (isAi || resumeBtn || pdfBtn) {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${pauseBtn}${resumeBtn}${pdfBtn}</div>`;
      }

      banner.style.background = cfg.bg;
      banner.style.color = "#fff";
      banner.innerHTML = `
        <div style="padding:8px 18px 7px;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${batchTag}${companyTag}${roleTag}${salaryTag}</div>
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
      document.getElementById("aa-btn-download-resume")?.addEventListener("click", () => {
        chrome.storage.local.get(["_aa_batchProgress"], (r) => {
          const bpData = r._aa_batchProgress;
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_RESUME",
            job: { company: bpData?.company || "Company", jobTitle: bpData?.title || "Resume" },
          });
          const btn = document.getElementById("aa-btn-download-resume");
          if (btn) { btn.textContent = "⬇️ Download again"; btn.disabled = false; btn.style.opacity = "1"; }
        });
      });
      document.getElementById("aa-btn-pause")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: true });
        showBanner("⏸ Paused — click Resume when ready.", "user", { showResume: true });
      });
      document.getElementById("aa-btn-resume")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: false });
        showBanner("Resuming...", "ai", { subtext: "Picking up where we left off..." });
      });
    });

    if (type === "success") banner._dismissTimer = setTimeout(() => banner.remove(), 15000);
    if (type === "error")   banner._dismissTimer = setTimeout(() => banner.remove(), 20000);
  }
})();
