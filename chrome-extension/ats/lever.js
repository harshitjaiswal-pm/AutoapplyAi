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

  showBanner("AutoApply is starting...", "ai", { subtext: "Waiting for page to finish loading..." });
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

  /**
   * Scrape enough job info from the current Lever page to build a pendingApplication
   * so the user can re-trigger tailoring + form-fill without going back to LinkedIn.
   */
  function scrapeJobInfoFromLeverPage() {
    // Job title — Lever uses h2 with data-qa or a prominent heading
    const titleEl = document.querySelector(
      'h2[data-qa="posting-name"], .posting-headline h2, h1, h2'
    );
    const title = titleEl?.innerText?.trim() || document.title.replace(/ [\-–|].*$/, "").trim();

    // Company — derive from domain (jobs.lever.co/company) or page content
    const pathParts = location.pathname.split("/").filter(Boolean);
    const companySlug = pathParts[0] || "";
    const companyEl = document.querySelector('.main-header-logo img, .company-name, [class*="company"]');
    const company = companyEl?.getAttribute("alt")
      || companyEl?.innerText?.trim()
      || (companySlug ? companySlug.charAt(0).toUpperCase() + companySlug.slice(1) : "");

    const jobDescription = scrapeLeverJD();

    if (!title) return null;
    return {
      jobTitle: title,
      company: company || "Company",
      jobDescription,
      jobUrl: location.href,
      source: "direct",
      _queuedAt: Date.now(),
    };
  }

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      LOG("No pending application — offering manual re-trigger");
      // Scrape what we can from the page so the user can start from here
      const scraped = scrapeJobInfoFromLeverPage();
      showBanner(
        scraped
          ? `${scraped.jobTitle} — ready to apply`
          : "No active application found.",
        "user",
        {
          subtext: scraped
            ? "AutoApply can fill and tailor this application for you."
            : "Open a job from LinkedIn with AutoApply, or use the button below.",
          applyNowJob: scraped,   // passed to showBanner so it can wire the button
        }
      );
      return;
    }

    const pendingJob = stored.pendingApplication;
    // Remove pendingApplication immediately so any re-injection (SW restart) exits early
    chrome.storage.local.remove(["pendingApplication"]);
    LOG("Processing Lever application for", pendingJob.jobTitle);
    showBanner("Preparing your application...", "ai");

    try {
      // Scrape JD from Lever page (more complete than LinkedIn)
      const pageJD = scrapeLeverJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      // Store pay range in batch progress so banner can display it
      storeSalaryRangeInProgress(extractPayRangeFromJD(jobDescription));

      // ── STEP 1: Fill basic fields IMMEDIATELY from profile (no AI wait) ──
      showBanner("Filling your details...", "ai", { subtext: "Tailoring resume in background — basic fields filled now." });
      await fillBasicFieldsOnly();

      // ── STEP 2: Fire tailoring as background Promise — don't block ──
      showBanner("Tailoring your resume for this role...", "ai", { subtext: "Basic info filled ✓ — personalising resume now..." });
      // Check if we already have a valid tailored result for this job — skip re-tailoring on retry
      const cacheData = await new Promise(resolve => chrome.storage.local.get(["lastTailoredResult", "lastTailoredJob"], resolve));
      // isSameJob requires BOTH title AND company to match (title alone is too loose —
      // two different "Senior Product Manager" roles at different companies would incorrectly share a cache).
      const isSameJob = cacheData.lastTailoredJob?.applyUrl === window.location.href
        || (cacheData.lastTailoredJob?.jobTitle === pendingJob.jobTitle
            && cacheData.lastTailoredJob?.company === pendingJob.company);

      // Clear stale PDF from a previous job so we never upload the wrong resume
      if (!isSameJob) {
        chrome.storage.local.remove(["tailoredResumePdf", "tailoredResumeFilename"]);
        LOG("Cleared stale resume PDF (different job)");
      }

      const tailoringPromise = (cacheData.lastTailoredResult && isSameJob)
        ? Promise.resolve({ tailoredResult: cacheData.lastTailoredResult })
        : sendMessageWithTimeout({
          type: "TAILOR_AND_FILL",
          job: { ...pendingJob, jobDescription },
        }, 90000).catch(err => {
          LOG("Tailoring failed:", err.message);
          return null;
        });

      // ── STEP 3: Wait for tailoring, then fill remaining fields ──
      const tailoredData = await tailoringPromise;

      if (!tailoredData?.tailoredResult) {
        LOG("Tailoring returned no data — form filled with base profile data");
        showBanner("Resume personalisation unavailable — form filled with your profile.", "user", { subtext: "Review highlighted fields and submit when ready." });
        return;
      }

      showBanner("Resume tailored ✓ — filling remaining fields...", "ai");
      LOG("Got tailored result, filling custom questions");

      // Fill cover letter, custom questions, and EEO fields with tailored data
      await fillRemainingFields(tailoredData.tailoredResult, pendingJob, jobDescription);

      // Attempt programmatic resume upload
      await attemptResumeUpload();

      showBanner("Form filled — review and submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      LOG("Error:", err.message, "\nStack:", err.stack);
      window.__aa_last_err_stack = err.stack;
      try { localStorage.setItem("_aa_last_err_stack", err.stack); } catch(_) {}
      showBanner("Error filling form — basic info filled as fallback.", "error", { subtext: err.message });
      await fillBasicFieldsOnly();
      LOG("Showing amber banner now");
      showBanner("Basic info filled — review remaining fields and submit.", "user", { subtext: "Some fields may need manual input." });
      LOG("Amber banner shown");
    }
  }

  /* ── JD Scraping ── */

  /** Extract max base pay from a JD string. Returns integer string or null. */
  function extractMaxPayFromJD(jdText) {
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

  /**
   * Fill cover letter, custom questions, and EEO fields — called AFTER tailoring resolves.
   * Basic fields (name/email/phone/LinkedIn) are already filled by fillBasicFieldsOnly().
   */
  async function fillRemainingFields(tailoredResult, job, jobDescription) {
    LOG("fillRemainingFields entered");
    const stored = await chrome.storage.local.get(["userProfile"]);
    const user = stored.userProfile || {};

    // Cover letter / additional info
    if (tailoredResult?.coverLetter) {
      fillTextarea('textarea[name*="comments"], textarea[name*="additional"], textarea[name*="coverLetter"]', tailoredResult.coverLetter);
    }

    // Custom questions (compensation, work auth, EEO, etc.)
    await fillCustomQuestions(tailoredResult, user, jobDescription);

    LOG("Remaining fields filled");
  }

  /** @deprecated — use fillRemainingFields for tailored content, fillBasicFieldsOnly for profile data */
  async function fillLeverForm(tailoredResult, job, jobDescription) {
    LOG("fillLeverForm entered, jobDescription type:", typeof jobDescription);
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
    if (tailoredResult?.coverLetter) {
      fillTextarea('textarea[name*="comments"], textarea[name*="additional"], textarea[name*="coverLetter"]', tailoredResult.coverLetter);
    }

    // Try to fill custom questions by matching labels
    await fillCustomQuestions(tailoredResult, user, jobDescription);

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

    // Current company / org
    if (user.currentEmployer || user.currentCompany) {
      fillInput('input[name="org"], input[name*="company"], input[name*="current_company"]', user.currentEmployer || user.currentCompany);
    }
    // Current location (city or city+province)
    const location = [user.city, user.province].filter(Boolean).join(", ");
    if (location) {
      fillInput('input[name*="location"], input[id*="location"]', location);
    }

    // GitHub / Portfolio (fill immediately — no tailoring needed)
    if (user.github) {
      fillInput('input[name*="github"], input[name*="urls[GitHub]"], input[name*="urls[1]"]', user.github);
    }
    if (user.portfolio || user.website) {
      fillInput('input[name*="portfolio"], input[name*="urls[Portfolio]"], input[name*="website"], input[name*="urls[2]"]', user.portfolio || user.website);
    }

    LOG("Basic fields filled");
  }

  async function fillCustomQuestions(tailoredResult, user, jobDescription) {
    LOG("fillCustomQuestions called, jobDescription type:", typeof jobDescription);
    // Lever custom questions are typically in .custom-question containers
    const questions = document.querySelectorAll('.application-question, [class*="custom-question"], .additional-fields .field');
    if (questions.length === 0) { LOG("No custom questions found"); return; }

    LOG("Found", questions.length, "custom question containers");

    for (const q of questions) {
      const label = q.querySelector("label, .field-label, legend");
      if (!label) continue;
      const labelText = label.textContent.trim().toLowerCase();

      // Compensation / salary expectations
      if (labelText.includes("compensation") || labelText.includes("salary") || labelText.includes("pay expectation") || labelText.includes("expected pay")) {
        const input = q.querySelector("input[type='text'], input[type='number'], textarea");
        if (input && !input.value?.trim()) {
          const maxPay = extractMaxPayFromJD(jobDescription) || user.salaryExpectation || user.compensation || "";
          if (maxPay) fillInputEl(input, maxPay);
        }
        continue;
      }

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

      // Criminal record / background check
      if (labelText.includes("criminal") || labelText.includes("criminal record") || labelText.includes("background check")) {
        const radios = q.querySelectorAll('input[type="radio"]');
        const select = q.querySelector("select");
        if (radios.length > 0) fillRadio(radios, "No");
        else if (select) fillSelect(select, "No");
        continue;
      }

      // ── EEO / Diversity fields ──────────────────────────────────────────────

      // Age range — radio buttons (e.g. "Under 30", "30–39", "40–49", "50+", "Prefer not to answer")
      if (labelText.includes("age range") || labelText.includes("age group") || labelText.includes("what is your age") || labelText.includes("how old are you")) {
        const radios = q.querySelectorAll('input[type="radio"]');
        if (radios.length > 0) {
          // Try to pick age range from userProfile.age if set; otherwise "Prefer not to answer"
          const age = parseInt(user.age, 10) || 0;
          let targetLabel = "Prefer not to answer";
          if (age > 0) {
            if (age < 30) targetLabel = "under 30";
            else if (age < 40) targetLabel = "30";
            else if (age < 50) targetLabel = "40";
            else if (age < 60) targetLabel = "50";
            else targetLabel = "60";
          }
          // Try to find matching radio; fall back to "Prefer not to answer"
          let matched = false;
          for (const radio of radios) {
            const rl = (radio.closest("label")?.textContent?.trim().toLowerCase() ||
                        document.querySelector(`label[for="${radio.id}"]`)?.textContent?.trim().toLowerCase() ||
                        radio.value?.toLowerCase() || "");
            if (rl.includes(targetLabel.toLowerCase())) {
              radio.checked = true;
              radio.dispatchEvent(new Event("change", { bubbles: true }));
              LOG(`EEO age range → "${rl}"`);
              matched = true;
              break;
            }
          }
          if (!matched) {
            // Fall back to "Prefer not to answer"
            for (const radio of radios) {
              const rl = (radio.closest("label")?.textContent?.trim().toLowerCase() ||
                          document.querySelector(`label[for="${radio.id}"]`)?.textContent?.trim().toLowerCase() ||
                          radio.value?.toLowerCase() || "");
              if (rl.includes("prefer not") || rl.includes("decline") || rl.includes("not to answer") || rl.includes("no answer")) {
                radio.checked = true;
                radio.dispatchEvent(new Event("change", { bubbles: true }));
                LOG(`EEO age range fallback → "Prefer not to answer"`);
                break;
              }
            }
          }
        }
        continue;
      }

      // Ethnicity / race — checkboxes ("Prefer not to answer" if available, else leave unchecked)
      if (labelText.includes("ethnic") || labelText.includes("race") || labelText.includes("racial") ||
          labelText.includes("ancestry") || labelText.includes("heritage")) {
        const checkboxes = q.querySelectorAll('input[type="checkbox"]');
        if (checkboxes.length > 0) {
          // Find and check "Prefer not to answer" / "Decline to answer" option
          let foundPrefer = false;
          for (const cb of checkboxes) {
            const cl = (cb.closest("label")?.textContent?.trim().toLowerCase() ||
                        document.querySelector(`label[for="${cb.id}"]`)?.textContent?.trim().toLowerCase() ||
                        cb.value?.toLowerCase() || "");
            if (cl.includes("prefer not") || cl.includes("decline") || cl.includes("not to answer") || cl.includes("no answer") || cl.includes("i choose not")) {
              if (!cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event("change", { bubbles: true }));
                LOG(`EEO ethnicity → "Prefer not to answer"`);
              }
              foundPrefer = true;
              break;
            }
          }
          if (!foundPrefer) {
            LOG("EEO ethnicity: no 'Prefer not to answer' option — leaving unchecked");
          }
        }
        continue;
      }

      // Gender identity (EEO)
      if (labelText.includes("gender identity") || labelText.includes("what is your gender") || labelText.includes("gender?")) {
        const select = q.querySelector("select");
        const radios = q.querySelectorAll('input[type="radio"]');
        const value = "Prefer not to answer";
        if (select) fillSelect(select, value);
        else if (radios.length > 0) fillRadio(radios, "prefer not");
        continue;
      }

      // Veteran / military status (EEO)
      if (labelText.includes("veteran") || labelText.includes("military service") || labelText.includes("armed forces")) {
        const select = q.querySelector("select");
        const radios = q.querySelectorAll('input[type="radio"]');
        // Common options: "I am not a protected veteran", "Prefer not to answer"
        if (select) fillSelect(select, "not a protected");
        else if (radios.length > 0) {
          fillRadio(radios, "not a protected") || fillRadio(radios, "prefer not");
        }
        continue;
      }

      // Disability status (EEO)
      if (labelText.includes("disability") || labelText.includes("disabled") || labelText.includes("accommodation")) {
        const select = q.querySelector("select");
        const radios = q.querySelectorAll('input[type="radio"]');
        if (select) fillSelect(select, "prefer not");
        else if (radios.length > 0) fillRadio(radios, "prefer not");
        continue;
      }
    }
  }

  /* ── Resume Upload ── */

  async function attemptResumeUpload() {
    // Get the tailored resume PDF from storage
    // [AutoQA fix 2026-04-07] Also read _aa_batchProgress to populate job context for DOWNLOAD_RESUME filename
    const stored = await chrome.storage.local.get(["tailoredResumePdf", "_aa_batchProgress"]);
    const bp = stored._aa_batchProgress || {};
    const jobCtx = { company: bp.company || "", jobTitle: bp.title || bp.jobTitle || "" };

    if (!stored.tailoredResumePdf) {
      LOG("No tailored resume PDF in storage — downloading instead");
      // Fall back to download
      chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: jobCtx });
      return;
    }

    // Find the resume file input
    const fileInput = document.querySelector('input[type="file"][name*="resume"], input[type="file"]');
    if (!fileInput) {
      LOG("No file input found for resume upload");
      chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: jobCtx });
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
    if (!radios || !value) return false;
    const valueLower = value.toLowerCase();
    for (const radio of radios) {
      const label = radio.closest("label")?.textContent?.trim().toLowerCase()
        || document.querySelector(`label[for="${radio.id}"]`)?.textContent?.trim().toLowerCase()
        || radio.nextSibling?.textContent?.trim().toLowerCase()
        || radio.value?.toLowerCase() || "";
      if (label.includes(valueLower) || valueLower.includes(label)) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        LOG("Selected radio:", label);
        return true;
      }
    }
    return false;
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
        ? `<button id="aa-btn-pause" style="${btnStyle}background:rgba(255,255,255,0.18);color:#fff;margin-left:auto;">⏸ Pause</button>`
        : "";
      const resumeBtn = opts.showResume
        ? `<button id="aa-btn-resume" style="${btnStyle}background:rgba(255,255,255,0.3);color:#fff;">▶ Resume</button>`
        : "";

      let actionRow = "";
      if (type === "error") {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">🔄 Retry</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.4);">↺ Reload Resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">⏭ Skip Job</button>
          ${pdfBtn}
        </div>`;
      } else if (type === "user") {
        // "Apply with AutoApply" — shown when no pendingApplication but we scraped job info
        const applyNowBtn = opts.applyNowJob
          ? `<button id="aa-btn-apply-now" style="${btnStyle}background:#fff;color:#4F46E5;font-size:12px;">🤖 Apply with AutoApply</button>`
          : "";
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          ${applyNowBtn}
          ${resumeBtn}
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">🔄 Try Again</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.4);">↺ Reload Resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">⏭ Skip Job</button>
          ${pdfBtn}
        </div>`;
      } else if (isAi) {
        const innerBtns = [pdfBtn, pauseBtn].filter(Boolean).join("");
        actionRow = innerBtns ? `<div style="margin-top:6px;display:flex;gap:6px;align-items:center;">${innerBtns}</div>` : "";
      }

      banner.style.background = cfg.bg;
      banner.style.color = "#fff";
      banner.innerHTML = `
        <button id="aa-btn-collapse" style="
          all: initial;
          position: absolute;
          top: 6px; right: 8px;
          background: rgba(255,255,255,0.15);
          border: none; border-radius: 4px;
          color: #fff; font-size: 11px; font-weight: 700;
          cursor: pointer; padding: 2px 8px; line-height: 1.6;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          z-index: 1;
        " title="Collapse banner">▲</button>
        <div id="aa-banner-inner" style="padding:8px 36px 7px 18px;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${batchTag}${companyTag}${roleTag}${salaryTag}</div>
          ${progressBar}
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">${actorBadge}${statusMsg}${timerEl}</div>
          ${subtextRow}
          ${actionRow}
        </div>`;

      // Restore collapsed state across banner updates
      if (banner._collapsed) {
        const inner = document.getElementById("aa-banner-inner");
        if (inner) inner.style.display = "none";
        const colBtn = document.getElementById("aa-btn-collapse");
        if (colBtn) colBtn.textContent = "▼";
      }

      // Push page content down so the banner never hides anything
      requestAnimationFrame(() => {
        document.body.style.paddingTop = (banner.offsetHeight || 0) + "px";
      });

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
      // "Apply with AutoApply" — re-trigger full tailor+fill from this page
      document.getElementById("aa-btn-apply-now")?.addEventListener("click", () => {
        const job = opts.applyNowJob;
        if (!job) return;
        removeBanner();
        chrome.storage.local.set({ pendingApplication: job }, () => {
          // If we are on the job DETAIL page (no /apply suffix), navigate to the apply
          // page so the form is present when lever.js re-injects and fills it.
          // pendingApplication stays in storage — the /apply page injection will consume it.
          if (!window.location.pathname.endsWith("/apply")) {
            const applyUrl = window.location.href.replace(/\/?$/, "/apply");
            window.location.href = applyUrl;
          } else {
            // Already on /apply — re-run init() in place
            window.__autoapply_ats_injected = false;
            setTimeout(() => init(), 300);
          }
        });
      });

      document.getElementById("aa-btn-retry")?.addEventListener("click", () => {
        removeBanner();
        window.__autoapply_ats_injected = false;
        setTimeout(() => init(), 500);
      });
      document.getElementById("aa-btn-reload-resume")?.addEventListener("click", async () => {
        LOG("Reload Resume clicked — clearing cache and re-tailoring");
        removeBanner();
        // Clear all cached tailoring data so init triggers a fresh TAILOR_AND_FILL
        await new Promise(resolve => chrome.storage.local.remove([
          "tailoredResumePdf",
          "tailoredResumeFilename",
          "lastTailoredResult",
          "lastTailoredJob"
        ], resolve));
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
          if (btn) { btn.textContent = "⬇️ Download again"; btn.disabled = false; }
        });
      });
      document.getElementById("aa-btn-pause")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: true });
        showBanner("⏸ Paused — click Resume when ready.", "user", {
          subtext: "AutoApply will continue from where it left off.",
          showResume: true,
        });
      });
      document.getElementById("aa-btn-resume")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: false });
        showBanner("Resuming...", "ai", { subtext: "Picking up where we left off." });
      });

      document.getElementById("aa-btn-collapse")?.addEventListener("click", () => {
        const inner = document.getElementById("aa-banner-inner");
        const colBtn = document.getElementById("aa-btn-collapse");
        if (!inner || !colBtn) return;
        banner._collapsed = !banner._collapsed;
        if (banner._collapsed) {
          inner.style.display = "none";
          colBtn.textContent = "▼";
          colBtn.title = "Expand banner";
        } else {
          inner.style.display = "block";
          colBtn.textContent = "▲";
          colBtn.title = "Collapse banner";
        }
        requestAnimationFrame(() => {
          document.body.style.paddingTop = (banner.offsetHeight || 0) + "px";
        });
      });
    });

    if (type === "success") banner._dismissTimer = setTimeout(() => removeBanner(), 15000);
    if (type === "error")   banner._dismissTimer = setTimeout(() => removeBanner(), 20000);
  }

  /** Remove the banner and restore body padding. */
  function removeBanner() {
    const b = document.getElementById("autoapply-banner");
    if (!b) return;

    // Check if tailored PDF exists — if so, preserve the download button as a standalone element
    chrome.storage.local.get(["tailoredResumePdf"], (result) => {
      if (result.tailoredResumePdf) {
        const existingBtn = document.getElementById("aa-btn-download-resume");
        if (existingBtn && existingBtn.parentNode) {
          // Detach button before banner removal so it persists
          const clonedBtn = existingBtn.cloneNode(true);
          document.body.appendChild(clonedBtn);
          clonedBtn.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 99999;
            border: none; border-radius: 5px; padding: 8px 16px; font-size: 12px; font-weight: 700;
            cursor: pointer; background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: #fff;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2); transition: transform 0.2s;
          `;
          clonedBtn.addEventListener("mouseenter", (e) => e.target.style.transform = "scale(1.05)");
          clonedBtn.addEventListener("mouseleave", (e) => e.target.style.transform = "scale(1)");
          clonedBtn.addEventListener("click", () => {
            chrome.storage.local.get(["_aa_batchProgress"], (r) => {
              const bpData = r._aa_batchProgress;
              chrome.runtime.sendMessage({
                type: "DOWNLOAD_RESUME",
                job: { company: bpData?.company || "Company", jobTitle: bpData?.title || "Resume" },
              });
              clonedBtn.textContent = "⬇️ Download again";
              clonedBtn.disabled = false;
            });
          });
        }
      }
    });

    // Remove banner and restore padding
    b.remove();
    document.body.style.paddingTop = "";
  }

  /**
   * Inject the "⬇️ Resume" download button into the live banner immediately
   * when tailoredResumePdf becomes available — without waiting for the next
   * showBanner call. Idempotent: does nothing if button is already present.
   * Subsequent showBanner calls will include it naturally via the hasPdf check.
   */
  function injectOrRefreshDownloadButton() {
    if (document.getElementById("aa-btn-download-resume")) return;
    const banner = document.getElementById("autoapply-banner");
    if (!banner) return;
    chrome.storage.local.get(["tailoredResumePdf", "_aa_batchProgress"], (result) => {
      if (!result.tailoredResumePdf) return;
      if (document.getElementById("aa-btn-download-resume")) return;
      const wrapper = banner.querySelector("div");
      if (!wrapper) return;
      const bp = result._aa_batchProgress;
      const btn = document.createElement("button");
      btn.id = "aa-btn-download-resume";
      btn.style.cssText = "border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;background:#fff;color:#4F46E5;margin-top:6px;";
      btn.textContent = "⬇️ Resume";
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_RESUME",
          job: { company: bp?.company || "Company", jobTitle: bp?.title || "Resume" },
        });
        btn.textContent = "⬇️ Download again";
        btn.disabled = false;
      });
      wrapper.appendChild(btn);
      LOG("Persistent download button injected into banner");
    });
  }

  // Proactively show the download button the moment tailoredResumePdf is ready —
  // survives across showBanner calls since showBanner re-checks storage each time.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.tailoredResumePdf?.newValue) return;
    LOG("tailoredResumePdf ready — injecting persistent download button");
    injectOrRefreshDownloadButton();
  });
})();
