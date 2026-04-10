/**
 * ATS CONTENT SCRIPT — Workday (*.myworkdayjobs.com)
 *
 * Workday uses a custom SPA with non-standard form controls.
 * Multi-step flow: Job Posting → Apply Modal → My Information → My Experience → Application Questions → Review → Submit
 *
 * STATE MACHINE:
 * 1. DETECT_PAGE — Are we on a job posting page or already on the form?
 * 2. CLICK_APPLY — Click Apply button on job posting page
 * 3. HANDLE_MODAL — Click "Apply Manually" in the modal
 * 4. FILL_STEP1 — Fill "My Information" fields
 * 5. FILL_STEP2 — Handle "My Experience" (resume upload prompt)
 * 6. FILL_STEP3 — Fill "Application Questions"
 * 7. FILL_STEP4 — Review page — user must submit
 *
 * Key Workday selectors (data-automation-id):
 * - adventureButton: "Apply" on job posting
 * - applyManually: "Apply Manually" in modal
 * - useMyLastApplication: "Use My Last Application"
 * - formField-*: Form field containers
 * - pageFooterNextButton: "Next" / "Submit" button
 * - progressBarActiveStep: Shows "current step X of Y"
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  const LOG = (msg, ...args) => console.log(`AutoApply Workday: ${msg}`, ...args);

  /** Download the tailored resume for the CURRENT page using its URL as the primary key. */
  function _downloadResumeForPage() {
    chrome.storage.local.get(["tailoredResumeMap"], (r) => {
      const map = r.tailoredResumeMap || {};
      function _mk(job) {
        if (!job) return "default";
        const url = job.applyUrl || job.jobUrl || "";
        if (url) { try { const u = new URL(url); return (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80); } catch(_){} }
        const co = (job.company  || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
        const ti = (job.jobTitle || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
        return (co + "_" + ti) || "default";
      }
      // Priority 1: exact page URL key
      const pageKey = _mk({ applyUrl: window.location.href });
      if (map[pageKey]) {
        LOG("Downloading by exact page key:", pageKey);
        chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: { applyUrl: window.location.href } });
        return;
      }
      // Priority 2: scan map by company name match against current page URL / title
      const urlLower   = window.location.href.toLowerCase();
      const titleLower = (document.title || "").toLowerCase();
      const matched = Object.values(map).find(entry => {
        if (!entry.company) return false;
        const co = entry.company.toLowerCase().replace(/\s+/g, "");
        return urlLower.includes(co) || titleLower.includes(co);
      });
      if (matched) {
        LOG("Found resume by company match:", matched.company, "filename:", matched.filename);
        chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: { applyUrl: matched.jobUrl || window.location.href } });
        return;
      }
      // Priority 3: global fallback
      LOG("No company match — using global tailoredResumePdf fallback");
      chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: { applyUrl: window.location.href } });
    });
  }
  LOG("Script loaded on", window.location.href);

  // ── Profile bridge: expose profile to page context so dev/debug tools can read it ──
  // Also handles RELOAD_EXTENSION and GET_PROFILE requests from page.
  chrome.storage.local.get(["userProfile"], (r) => {
    if (r.userProfile) window.__aa_profile = r.userProfile;
  });
  window.addEventListener("message", (e) => {
    // Allow messages from same origin (page main world or isolated world).
    // e.source !== window can fail in isolated-world content scripts, so we only
    // guard on same-origin to prevent cross-frame injection.
    if (!e.data?.__aa_cmd) return;
    if (e.origin && e.origin !== location.origin) return;
    if (e.data.__aa_cmd === "GET_PROFILE") {
      chrome.storage.local.get(["userProfile"], (r) => {
        window.__aa_profile = r.userProfile || {};
        window.dispatchEvent(new CustomEvent("__aa_profile_ready", { detail: r.userProfile || {} }));
      });
    }
    if (e.data.__aa_cmd === "RELOAD_EXTENSION") {
      chrome.runtime.sendMessage({ type: "RELOAD_EXTENSION" });
    }
    if (e.data.__aa_cmd === "GET_RESUME") {
      chrome.storage.local.get(["parsedResume"], (r) => {
        window.__aa_resume = r.parsedResume || {};
        window.dispatchEvent(new CustomEvent("__aa_resume_ready", { detail: r.parsedResume || {} }));
      });
    }
    if (e.data.__aa_cmd === "SET_PENDING_APPLICATION") {
      // Allows QA / dev tooling to inject a pendingApplication without going
      // through the normal AutoApply button flow. The payload should contain
      // at minimum: { jobTitle, company, jobUrl }.
      const job = e.data.payload || {};
      chrome.storage.local.set({ pendingApplication: job, _aa_paused: false }, () => {
        window.dispatchEvent(new CustomEvent("__aa_pending_set", { detail: job }));
        LOG("pendingApplication set via bridge:", job.jobTitle);
        // Re-trigger state machine so it picks up the newly-set pendingApplication
        startStateMachine();
      });
    }
    if (e.data.__aa_cmd === "RESUME") {
      chrome.storage.local.set({ _aa_paused: false }, () => LOG("Resumed via bridge"));
    }
  });

  // Show banner immediately — user sees feedback before the init delay fires
  showBanner("Opening your application…", "ai", { subtext: "Waiting for the page to finish loading…" });
  // Start after a delay to let Workday render
  setTimeout(() => startStateMachine(), 2000);

  /* ═══════════════════ STATE MACHINE ═══════════════════ */

  async function startStateMachine() {
    // Always clear stale pause state — a page reload means a fresh session
    await new Promise(resolve => chrome.storage.local.set({ _aa_paused: false }, resolve));

    const stored = await chrome.storage.local.get(["pendingApplication"]);
    let pendingJob = stored.pendingApplication;

    // Issue #1: If no pendingApplication and we're on a form page, try to extract job info from DOM
    if (!pendingJob) {
      const page = detectPage();
      if (page === "form") {
        LOG("No pendingApplication found but detected form page — attempting to extract job info from DOM");
        pendingJob = extractJobInfoFromPage();
        if (pendingJob) {
          LOG("Extracted job info from page:", pendingJob);
          // Store it so future reloads can use it
          await new Promise(resolve => chrome.storage.local.set({ pendingApplication: pendingJob }, resolve));
        }
      }
    }

    if (!pendingJob) {
      LOG("No pending application found — watching for Apply button if user navigates");
      return;
    }

    LOG("Processing application for", pendingJob.jobTitle);
    showBanner("Preparing Workday application...", "ai");

    try {
      const page = detectPage();
      LOG("Detected page type:", page);

      if (page === "jobPosting") {
        showBanner("Opening your application…", "ai");
        const clicked = await navigateToForm();

        if (!clicked) {
          // Couldn't find Apply button — ask user to click it, then wait
          showBanner("Click the Apply button to open the application form.", "user",
            { subtext: "AutoApply will detect the form and continue automatically." });
        }

        // Wait for the Workday form to render (up to 20s)
        const formEl = await waitForElement(
          '[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="applyFlowPage"], [data-automation-id="progressBar"]',
          20000
        );
        if (!formEl) {
          showBanner("Application form didn't load — please open it manually.", "user",
            { subtext: "Navigate to the Apply page and AutoApply will pick up automatically." });
          return;
        }
        await sleep(1500); // Let fields fully render

      } else if (page === "modal") {
        await handleApplyModal();
        const formEl = await waitForElement(
          '[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="applyFlowPage"], [data-automation-id="progressBar"]',
          15000
        );
        if (!formEl) return;
        await sleep(1500);
      }
      // else: already on form page

      // Now confirmed on the form — start tailoring + filling
      await processCurrentStep(pendingJob);

    } catch (err) {
      LOG("Error:", err);
      showBanner(`Error — please apply manually.`, "error", { subtext: err.message });
    }
  }

  /* ═══════════════════ JOB EXTRACTION (Issue #1) ═══════════════════ */

  /**
   * Extract minimal job info from the Workday page when user navigates directly
   * without a pendingApplication. Extracts job title from H1/heading and company from URL.
   */
  function extractJobInfoFromPage() {
    try {
      // Try to extract job title from H1 or main heading
      let jobTitle = "";
      const h1 = document.querySelector("h1");
      if (h1) {
        jobTitle = h1.textContent?.trim() || "";
      }
      // Fallback: look for heading with common job title patterns
      if (!jobTitle) {
        const allHeadings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"));
        const headingText = allHeadings
          .map(h => h.textContent?.trim())
          .find(text => text && text.length > 0 && text.length < 200);
        jobTitle = headingText || "";
      }

      // Extract company from URL (e.g., "autodesk" from "autodesk.wd1.myworkdayjobs.com")
      const urlMatch = window.location.hostname.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/i);
      const company = urlMatch ? urlMatch[1] : "";

      if (jobTitle && company) {
        return {
          jobTitle: jobTitle,
          company: company,
          jobUrl: window.location.href,
          // User navigated directly — we don't have a full JD but the state machine will handle it gracefully
        };
      }

      LOG("Could not extract sufficient job info from page (title or company missing)");
      return null;
    } catch (err) {
      LOG("Error extracting job info:", err.message);
      return null;
    }
  }

  /* ═══════════════════ PAGE DETECTION ═══════════════════ */

  function detectPage() {
    // Check if we're on the application form (has step indicators)
    const progressBar = document.querySelector('[data-automation-id="progressBar"]');
    const applyFlowPage = document.querySelector('[data-automation-id="applyFlowPage"]');
    if (progressBar || applyFlowPage) {
      return "form";
    }

    // Check if there's an Apply modal open
    const applyManuallyBtn = document.querySelector('[data-automation-id="applyManually"]');
    const useLastAppBtn = document.querySelector('[data-automation-id="useMyLastApplication"]');
    if (applyManuallyBtn || useLastAppBtn) {
      return "modal";
    }

    // Check if we're on a job posting page (has Apply button)
    const applyBtn = document.querySelector('[data-automation-id="adventureButton"]');
    if (applyBtn) {
      return "jobPosting";
    }

    // URL-based detection fallback
    const url = window.location.href.toLowerCase();
    if (url.includes("/apply")) {
      return "form";
    }

    return "jobPosting"; // Default — try Apply flow
  }

  /* ═══════════════════ NAVIGATION ═══════════════════ */

  async function navigateToForm() {
    // 1. Wait for the Workday Apply button to render (React SPA may be slow)
    let applyBtn = await waitForElement('[data-automation-id="adventureButton"]', 6000);

    // 2. Generic fallback — any link/button whose visible text is "Apply" or similar
    if (!applyBtn) {
      const candidates = Array.from(document.querySelectorAll('a[href], button'));
      applyBtn = candidates.find(el => {
        const text = (el.textContent?.trim() || "").toLowerCase();
        return text === "apply" || text === "apply now" || text === "apply for this job" || text === "apply for job";
      });
    }

    if (!applyBtn) {
      LOG("No Apply button found on posting page");
      return false;
    }

    LOG("Clicking Apply button:", applyBtn.textContent?.trim());
    applyBtn.click();
    await sleep(2000);

    // Handle the Apply / Apply Manually modal if one appeared
    await handleApplyModal();
    return true;
  }

  async function handleApplyModal() {
    // Wait for modal to appear
    const modalBtn = await waitForElement(
      '[data-automation-id="applyManually"], [data-automation-id="useMyLastApplication"]',
      8000
    );

    if (!modalBtn) {
      LOG("No modal appeared — may have gone directly to form");
      return;
    }

    // Click "Apply Manually" (preferred) or "Use My Last Application"
    const applyManually = document.querySelector('[data-automation-id="applyManually"]');
    if (applyManually) {
      LOG("Clicking 'Apply Manually'");
      applyManually.click();
    } else {
      const useLastApp = document.querySelector('[data-automation-id="useMyLastApplication"]');
      if (useLastApp) {
        LOG("Clicking 'Use My Last Application'");
        useLastApp.click();
      }
    }

    await sleep(2000); // Wait for form page to load
  }

  /* ═══════════════════ STEP PROCESSING ═══════════════════ */

  async function processCurrentStep(pendingJob) {
    try {
      const step = getCurrentStep();
      LOG("Current step:", step);

      // Scrape JD if available (might still be in DOM from job posting)
      const pageJD = scrapeWorkdayJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      // Store pay range in batch progress so the banner can display it
      storeSalaryRangeInProgress(extractPayRangeFromJD(jobDescription));

      // ── Fire tailoring immediately as a background Promise — don't block on it ──
      // Step 1 only needs base profile data; tailoring is needed for Step 2/3.
      // Check if we already have a valid tailored result for this job — skip re-tailoring on retry
      const cacheData = await new Promise(resolve => chrome.storage.local.get(["lastTailoredResult", "lastTailoredJob"], resolve));
      const isSameJob = cacheData.lastTailoredJob?.applyUrl === window.location.href
        || cacheData.lastTailoredJob?.jobTitle === pendingJob.jobTitle;

      const tailoringPromise = (cacheData.lastTailoredResult && isSameJob)
        ? Promise.resolve({ tailoredResult: cacheData.lastTailoredResult })
        : sendMessageWithTimeout({
          type: "TAILOR_AND_FILL",
          job: { ...pendingJob, jobDescription },
        }, 90000).then(result => {
          if (result?.error) LOG("Tailoring error:", result.error);
          return result;
        }).catch(err => {
          LOG("Tailoring failed:", err.message);
          return null; // Graceful degradation — fill with base data
        });

      if (step === "login") {
        // Workday is showing a "Create Account / Sign In" gate — not a fillable form step.
        // Stop here and prompt the user to sign in, then click Retry.
        showBanner(
          "Login required — create an account or sign in, then click Retry.",
          "user",
          { subtext: "Workday requires an account for this employer. AutoApply will resume after you sign in." }
        );
        return; // don't spin waiting for a step that will never arrive

      } else if (step === 1) {
        // Fill Step 1 immediately with base profile — no tailoring needed here
        showBanner("Filling in your details…", "ai", { subtext: "Tailoring resume in background…" });
        await fillStep1(null, pendingJob);

        // Advance to Step 2 — fail fast if errors
        const advanced = await advanceToStep(2);
        if (!advanced) {
          showBanner("Please fix the form errors and we'll continue.", "user");
          return;
        }

        // Now we're on Step 2 — wait for tailoring (likely already done by now)
        showBanner("Tailoring your resume for this role...", "ai", { subtext: "Your personalised PDF is being prepared — a download button will appear when it's ready." });
        const tailoredData = await tailoringPromise;
        showBanner("Resume tailored ✓ — uploading to application...", "ai", { subtext: "Filling your experience, questions and uploading your tailored PDF." });
        await handleStep2ResumeUpload(tailoredData, pendingJob);

      } else if (step === 2) {
        // Landed directly on Step 2 — wait for tailoring then upload
        showBanner("Tailoring your resume for this role...", "ai", { subtext: "Your personalised PDF is being prepared — a download button will appear when it's ready." });
        const tailoredData = await tailoringPromise;
        showBanner("Resume tailored ✓ — uploading to application...", "ai", { subtext: "Filling your experience, questions and uploading your tailored PDF." });
        await handleStep2ResumeUpload(tailoredData, pendingJob);

      } else if (step === 3) {
        // Application questions — may span multiple pages + Voluntary Disclosures
        showBanner("Filling application questions...", "ai", { subtext: "Tailoring in progress..." });
        const tailoredData = await tailoringPromise;
        // Use the same loop as continueFromStep2 to handle multi-page App Q + disclosures
        await fillStep3(tailoredData?.tailoredResult, pendingJob);
        let loopGuard = 0;
        while (loopGuard++ < 6) {
          const s = getCurrentStep();
          if (s === 4) break;
          if (s === 3) {
            await sleep(800);
            await fillStep3(tailoredData?.tailoredResult, pendingJob);
            await advanceToStep(s + 1);
            await sleep(1500);
          } else if (s === 3.5) {
            showBanner("Handling voluntary disclosures...", "ai");
            await fillVoluntaryDisclosures();
            await advanceToStep(4);
            await sleep(1500);
          } else {
            await advanceToStep(s + 1);
            await sleep(1500);
          }
        }
        await waitForStep(4, 15000);
        showBanner("Your turn — review and submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
        watchForSubmit(pendingJob);

      } else if (step === 3.5) {
        // Resumed directly on Voluntary Disclosures page
        showBanner("Handling voluntary disclosures...", "ai");
        await fillVoluntaryDisclosures();
        await advanceToStep(4);
        await waitForStep(4, 15000);
        showBanner("Your turn — review and submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
        watchForSubmit(pendingJob);

      } else if (step === 4) {
        LOG("On Review step — user should review and submit");
        showBanner("Your turn — review and submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
        watchForSubmit(pendingJob);
      }
    } catch (err) {
      // Issue #13: Wrap state machine in try/catch to prevent silent failures
      LOG("Error in processCurrentStep:", err.message, err.stack);
      showBanner("An error occurred — please try again or apply manually.", "error",
        { subtext: err.message || "Unknown error" });
    }
  }

  /**
   * Handle Step 2 (My Experience / Resume Upload).
   * Downloads the tailored PDF, shows a persistent "waiting" banner,
   * watches for the user to upload the file, then continues automatically.
   */
  async function handleStep2ResumeUpload(tailoredData, pendingJob) {
    // Guard: only proceed if there's actually a file upload area on this page.
    // If we're still on Step 1 (e.g. form errors prevented advancing), bail out.
    const hasUploadArea =
      document.querySelector('[data-automation-id="file-upload-input-ref"]') ||
      document.querySelector('[data-automation-id="fileUploader"]') ||
      document.querySelector('input[type="file"]');

    if (!hasUploadArea) {
      // No file upload widget — this Workday instance uses structured form fields instead.
      // Skip the PDF upload entirely and go straight to filling work experience / education.
      LOG("No file upload found on Step 2 — filling structured form fields directly");
      showBanner("Filling your experience details...", "ai", { subtext: "No resume upload required — filling form fields directly." });
      await continueFromStep2(tailoredData, pendingJob);
      return;
    }

    // First try programmatic upload — if Workday allows it, great
    const uploaded = await uploadResumeProgrammatically();

    if (uploaded) {
      // Programmatic upload succeeded — proceed automatically
      await sleep(2000); // Give Workday time to register the upload
      showBanner("Resume uploaded! Filling remaining details...", "ai");
      await continueFromStep2(tailoredData, pendingJob);
      return;
    }

    // Programmatic upload failed — show download button, then wait for manual upload
    showBanner(
      "Tailored resume ready — download it, then upload it above.",
      "user",
      {
        subtext: "Drag the PDF into the upload box above · AutoApply will take over automatically.",
        downloadBtn: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      }
    );

    LOG("Waiting for user to upload resume...");

    // Watch for the file to appear in the upload area
    const uploaded2 = await waitForResumeUpload(120000); // 2-minute timeout

    if (!uploaded2) {
      showBanner("Resume upload timed out — please complete the application manually.", "error");
      chrome.storage.local.remove(["pendingApplication"]);
      return;
    }

    // User uploaded — take over and finish the application
    showBanner("Resume detected! Taking over the rest of the application...", "ai");
    LOG("Resume upload detected — advancing through remaining steps");
    await sleep(2000); // Let Workday fully process the upload before advancing

    await continueFromStep2(tailoredData, pendingJob);
  }

  /**
   * Drive the application from Step 2 through to the Review page.
   * Called after the resume is confirmed uploaded (either programmatically or by the user).
   * Checks the advanceToStep() return value at each transition so we never show the
   * Review banner on the wrong page.
   */
  async function continueFromStep2(tailoredData, pendingJob) {
    // ── Step 2 → Step 3 ───────────────────────────────────────────────────────
    showBanner("Filling your experience details...", "ai", { subtext: "Filling work experience, education and optional fields..." });
    await fillStep2ExtraFields(tailoredData?.tailoredResult, pendingJob); // fill LinkedIn, website etc.
    await fillMyExperiencePage(tailoredData?.tailoredResult, pendingJob); // fill Work Exp / Education / Certs

    const to3 = await advanceToStep(3);
    if (!to3) {
      // Workday blocked the Next click — could be upload not counted yet
      showBanner("Please ensure your resume is uploaded, then click Next.", "user",
        { subtext: "AutoApply will continue automatically on the next step." });
      // Watch for the user to manually advance to Step 3
      await waitForStep(3, 300000);
    }

    // ── Step 3+ loop: Application Questions (1 of 2, 2 of 2…) + Voluntary Disclosures ──
    // Workday jobs may have multiple Application Questions pages followed by a
    // Voluntary Disclosures page before the final Review step. We loop until we
    // reach Review (step 4), handling each intermediate page type.
    let loopGuard = 0;
    while (loopGuard++ < 8) {
      const step = getCurrentStep();
      LOG(`Loop iteration ${loopGuard}: step = ${step}`);

      if (step === 4) break; // Reached Review — done

      if (step === 3) {
        // Application Questions page — fill it, then advance
        const onStep3 = await waitForStep(3, 15000);
        if (!onStep3) { LOG("waitForStep(3) timed out — breaking loop"); break; }

        showBanner("Filling application questions...", "ai");
        await sleep(800);
        await fillStep3(tailoredData?.tailoredResult, pendingJob);

        // Advance (may land on another App Q page or Voluntary Disclosures)
        showBanner("Advancing...", "ai");
        const advanced = await advanceToStep(step + 1);
        if (!advanced) {
          showBanner("Please review and fix any highlighted fields, then click Next.", "user");
          await waitForStep(4, 300000);
          break;
        }
        await sleep(1500); // Let the next page render

      } else if (step === 3.5) {
        // Voluntary Disclosures — check required checkboxes, then advance
        showBanner("Handling voluntary disclosures...", "ai");
        await sleep(500);
        await fillVoluntaryDisclosures();

        const advanced = await advanceToStep(4);
        if (!advanced) {
          showBanner("Please complete the Voluntary Disclosures and click Next.", "user");
          await waitForStep(4, 300000);
          break;
        }
        await sleep(1500);

      } else {
        // Unknown intermediate page — just try to advance
        LOG(`Unknown step ${step} — attempting to advance`);
        await advanceToStep(step + 1);
        await sleep(1500);
      }
    }

    // ── Step 4 (Review) ───────────────────────────────────────────────────────
    await waitForStep(4, 15000);
    showBanner("Your turn — review and submit when ready.", "user",
      { subtext: "AutoApply stops here — you stay in control of the final submit." });
    watchForSubmit(pendingJob);
    chrome.storage.local.remove(["pendingApplication"]);
  }

  /**
   * Wait until getCurrentStep() returns the expected step number.
   * Returns true when confirmed, false on timeout.
   */
  async function waitForStep(expectedStep, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (getCurrentStep() === expectedStep) return true;
      await sleep(500);
    }
    LOG(`waitForStep(${expectedStep}) timed out`);
    return false;
  }

  /**
   * Fill the optional extra fields on Step 2 (LinkedIn, website) WITHOUT
   * re-triggering the resume upload (that's already done).
   */
  async function fillStep2ExtraFields(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile", "parsedResume"]);
    const user = profile.userProfile || {};
    const resume = profile.parsedResume || {};

    // Job title / company (some Workday instances show these on Step 2)
    fillFormField("formField-jobTitle", resume.workExperience?.[0]?.title || "");
    fillFormField("formField-company", resume.workExperience?.[0]?.company || "");

    // LinkedIn
    const linkedinField = document.querySelector('[data-automation-id*="linkedin" i]') ||
                          document.querySelector('[data-automation-id*="LinkedIn"]');
    if (linkedinField) {
      const input = linkedinField.querySelector("input");
      if (input && !input.value && user.linkedin) setWorkdayValue(input, user.linkedin);
    }

    // Website / portfolio
    if (user.website || user.portfolio) {
      fillByLabelText(["website", "portfolio", "personal site"], user.website || user.portfolio);
    }

    await sleep(300);
  }

  /**
   * Poll for resume upload on Workday Step 2.
   * Watches for a file to appear in the upload area (either a filename chip
   * or a successful upload indicator). Returns true when detected.
   */
  async function waitForResumeUpload(timeoutMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 1000;

    // Selectors that indicate a file has been uploaded in Workday
    const uploadedSelectors = [
      '[data-automation-id="file-upload-item"]',          // File chip appears
      '[data-automation-id="attachmentTitle"]',            // Attachment title
      '[class*="fileUpload"] [class*="fileName"]',         // Generic filename in upload widget
      '.css-1p0sjhy',                                      // Workday file chip class (varies)
    ];

    while (Date.now() - startTime < timeoutMs) {
      // Check if any uploaded file indicators exist
      for (const sel of uploadedSelectors) {
        if (document.querySelector(sel)) {
          LOG("Resume upload detected via selector:", sel);
          return true;
        }
      }

      // Also check: did the file input get a file attached?
      const fileInput = document.querySelector('[data-automation-id="file-upload-input-ref"]') ||
                        document.querySelector('input[type="file"]');
      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        LOG("Resume upload detected via file input files list");
        return true;
      }

      // Check for "Successfully Uploaded" text in the upload area
      const uploadArea = document.querySelector('[data-automation-id="fileUploader"]') ||
                         document.querySelector('[class*="fileUpload"]');
      if (uploadArea && uploadArea.innerText?.toLowerCase().includes("successfully uploaded")) {
        LOG("Resume upload detected via success text");
        return true;
      }

      // Update banner every 10s so user knows we're still watching
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed > 0 && elapsed % 10 === 0) {
        const remaining = Math.round((timeoutMs - (Date.now() - startTime)) / 1000);
        showBanner(
          `Waiting for your resume upload... AutoApply will continue automatically.`,
          "user",
          { subtext: `${remaining}s remaining — upload the tailored PDF from your Downloads folder.` }
        );
      }

      await sleep(pollInterval);
    }

    return false; // Timed out
  }

  /**
   * Returns true if the page currently has Workday validation errors.
   * Covers: DOM selectors AND text-based detection of "Errors Found" banner.
   */
  function hasPageErrors() {
    // Selector-based: Workday field-level errors and error summary
    const bySelector = document.querySelectorAll(
      '[data-automation-id="validationError"], [data-automation-id="errorSummary"], ' +
      '[class*="ValidationError"], [class*="errorSummary"]'
    );
    if (bySelector.length > 0) return true;

    // Text-based: catches the "Errors Found" collapsible header Workday shows
    const pageText = document.body.innerText || "";
    if (
      pageText.includes("Errors Found") ||
      pageText.match(/Error:\s*(The field|This field|Required)/) ||
      pageText.includes("is required and must have a value")
    ) return true;

    return false;
  }

  /** Collect short error messages for display in the banner subtext. */
  function collectErrorTexts() {
    const els = document.querySelectorAll(
      '[data-automation-id="validationError"], [data-automation-id="errorSummary"] li, ' +
      '[class*="ValidationError"], [class*="errorSummary"] li'
    );
    const fromEls = Array.from(els).map(e => e.textContent?.trim()).filter(Boolean).slice(0, 3);
    if (fromEls.length) return fromEls;

    // Fallback: grab "Error - Field Name" lines from visible text
    const lines = (document.body.innerText || "").split("\n");
    return lines.filter(l => l.trim().startsWith("Error")).map(l => l.trim()).slice(0, 3);
  }

  /**
   * Auto-advance to the next step by clicking the Next button.
   * Checks for validation errors before and after clicking.
   */
  async function advanceToStep(nextStep) {
    LOG(`Advancing to Step ${nextStep}...`);

    // Honour pause — wait here until user clicks Resume
    await waitForResume();

    // Check for pre-existing validation errors on the page
    if (hasPageErrors()) {
      const errorTexts = collectErrorTexts();
      LOG(`WARNING: validation errors on page before clicking Next:`, errorTexts.join(", "));

      // If the ONLY errors are address/postal code (profile data gaps), proceed anyway
      // — Workday will catch these after the click and we show a clear message
      const allAddressRelated = errorTexts.every(e =>
        /address|postal|zip|postcode/i.test(e)
      );
      if (allAddressRelated && errorTexts.length > 0) {
        LOG("Only address/postal errors — proceeding anyway and letting Workday validate");
        // Fall through to Next click
      } else if (errorTexts.length > 0) {
        showBanner(`Form has validation errors — please fix the highlighted fields.`, "user", { subtext: errorTexts.join(" · ") });
        return false;
      }
    }

    // Find and click the Next button
    const nextBtn = document.querySelector('[data-automation-id="pageFooterNextButton"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Next');

    if (nextBtn) {
      // Use dispatchEvent(MouseEvent) instead of .click() — Workday's React synthetic
      // event system only fires when the event has a proper `view` property. Plain .click()
      // does NOT set view=window and is silently swallowed by React.
      nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      LOG(`Clicked Next button`);
    } else {
      LOG(`No Next button found to advance to Step ${nextStep}`);
      return false;
    }

    // Wait for Workday to validate then check for errors
    await sleep(1500);
    if (hasPageErrors()) {
      const errorTexts = collectErrorTexts();
      LOG(`Validation errors appeared after Next click:`, errorTexts.join(", "));
      showBanner(`Some required fields need attention — check highlighted fields.`, "user", { subtext: errorTexts.join(" · ") });
      return false;
    }

    // Wait for the next step to render
    const progressBar = await waitForElement('[data-automation-id="progressBarActiveStep"]', 8000);
    if (progressBar) {
      for (let i = 0; i < 20; i++) {
        const stepText = progressBar.textContent?.trim() || "";
        if (stepText.includes(String(nextStep)) || stepText.includes(`Step ${nextStep}`)) {
          LOG(`Successfully advanced to Step ${nextStep}`);
          await sleep(500);
          return true;
        }
        await sleep(100);
      }
    }

    await sleep(1000);
    LOG(`Advanced (verification uncertain)`);
    return true; // Optimistically treat as success if no errors detected
  }

  function getCurrentStep() {
    // Detect Workday "Create Account / Sign In" gating page BEFORE anything else
    const h2Text = (document.querySelector('h2')?.textContent || "").toLowerCase();
    if (
      h2Text.includes("create account") || h2Text.includes("sign in") ||
      document.querySelector('input[type="password"]')
    ) {
      return "login"; // special sentinel — handled in processCurrentStep
    }

    // Try progress bar active step — match by step NAME (Workday uses names, not "step N")
    const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    if (activeStep) {
      const text = (activeStep.textContent || "").toLowerCase();
      if (text.includes("my information")) return 1;
      if (text.includes("my experience")) return 2;
      if (text.includes("application questions")) return 3;
      if (text.includes("voluntary disclosures")) return 3.5;
      if (text.includes("review")) return 4;
      // Legacy: try numeric match as fallback
      const match = text.match(/step\s*(\d+)/i);
      if (match) return parseInt(match[1]);
    }

    // Fallback: detect by page content.
    // IMPORTANT: Check higher steps FIRST — the URL "applymanually" is the same
    // across ALL steps on many Workday instances, so URL-based step-1 detection
    // must be a last resort only.
    const pageText = document.body.innerText || "";

    if (pageText.includes("Review") && pageText.includes("Submit")) return 4;
    if (pageText.includes("Voluntary Disclosures") ||
        (pageText.includes("Terms and Conditions") && pageText.includes("acknowledge"))) return 3.5;
    if (pageText.includes("Application Questions")) return 3;
    if (pageText.includes("My Experience") &&
        (pageText.includes("Resume") || pageText.includes("Work Experience"))) return 2;
    if (pageText.includes("My Information") && pageText.includes("Legal Name")) return 1;

    // URL-based fallback — LAST RESORT (same URL for all steps on some Workday instances)
    const url = window.location.href.toLowerCase();
    if (url.includes("myinformation") || url.includes("applymanually")) return 1;

    return 1; // Default to step 1
  }

  /* ═══════════════════ VOLUNTARY DISCLOSURES ═══════════════════ */

  /**
   * Handle the Voluntary Disclosures page.
   * This page typically contains a Terms and Conditions section with one or more
   * checkboxes that the user must acknowledge (privacy statement, ViBE philosophy, etc.).
   * We check all required checkboxes and any acknowledgment checkboxes.
   */
  async function fillVoluntaryDisclosures() {
    LOG("Filling Voluntary Disclosures page");
    await sleep(500);

    // Check all unchecked checkboxes on this page
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const cb of checkboxes) {
      if (cb.checked) continue;

      // Get label text from surrounding context
      const labelEl = cb.closest('[data-automation-id^="formField"]')?.previousElementSibling ||
                      cb.closest('label') ||
                      cb.parentElement;
      const labelText = (labelEl?.textContent || "").toLowerCase();

      // Always check: acknowledgment, privacy, terms, agree, ViBE/VIBE, recruitment
      const shouldCheck =
        labelText.includes("acknowledge") ||
        labelText.includes("privacy") ||
        labelText.includes("agree") ||
        labelText.includes("vibe") ||
        labelText.includes("vibs") ||
        labelText.includes("terms") ||
        labelText.includes("recruit") ||
        labelText.length === 0; // No label — check it anyway (most likely required)

      if (shouldCheck) {
        try {
          // Use React props if available, otherwise plain click
          const propsKey = Object.keys(cb).find(k =>
            k.startsWith('__reactProps') || k.startsWith('__reactEventHandlers')
          );
          if (propsKey) {
            cb[propsKey]?.onChange?.({ target: { checked: true }, currentTarget: cb, type: 'change', preventDefault: () => {}, stopPropagation: () => {} });
          } else {
            cb.click();
          }
          await sleep(200);
          LOG(`Checked checkbox: "${labelText.substring(0, 60) || "(no label)"}"`);
        } catch (e) {
          cb.click(); // Fallback to plain click
          await sleep(200);
        }
      }
    }

    // Verify at least one checkbox was checked
    const checkedCount = Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).length;
    LOG(`Voluntary Disclosures: ${checkedCount} checkbox(es) checked`);
    await sleep(300);
  }

  /* ═══════════════════ STEP 1: MY INFORMATION ═══════════════════ */

  async function fillStep1(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile", "parsedResume"]);
    const user = profile.userProfile || {};
    const resume = profile.parsedResume || {};

    // Wait for form fields to render
    await waitForElement('[data-automation-id="formField-legalName--firstName"]', 10000);
    await sleep(500);

    const firstName = user.firstName || resume.contactInfo?.firstName || "";
    const lastName = user.lastName || resume.contactInfo?.lastName || "";
    const email = user.email || resume.contactInfo?.email || "";
    const rawPhone = user.phone || resume.contactInfo?.phone || "";
    // Workday expects local phone format (no country code). Strip +1- or +1 prefix.
    const phone = normalizePhone(rawPhone);
    // Parse "City, Province/Country" location string if structured fields are missing
    const locationStr = resume.contactInfo?.location || "";
    const locationParts = locationStr.split(",").map(s => s.trim());
    const cityFromLocation = locationParts[0] || "";
    // Strip country name — keep only province/state portion
    const provinceFromLocation = (locationParts[1] || "").replace(/\s*(canada|united states|usa?)\s*/gi, "").trim();

    const address = user.address || resume.contactInfo?.address || "";
    const province = user.province || resume.contactInfo?.province || provinceFromLocation || "";
    // Use stored city, or fall back to a major city for the province
    const city = user.city || resume.contactInfo?.city || cityFromLocation || getDefaultCity(province);
    const postalCode = user.postalCode || resume.contactInfo?.postalCode || getDefaultPostalCode(city, province);

    if (!postalCode) LOG("WARNING: No postal code found in profile — address validation may fail");

    LOG("Filling Step 1 — My Information");

    // BATCH TEXT FIELDS: Fill all text fields in a single synchronous loop
    // No sleeps between fields — only sleep ONCE after all are done
    const textFieldsToFill = [
      { id: "formField-legalName--firstName", value: firstName },
      { id: "formField-legalName--lastName", value: lastName },
      { id: "formField-addressLine1", value: address },
      { id: "formField-city", value: city },
      { id: "formField-postalCode", value: postalCode },
      { id: "formField-emailAddress", value: email },
      { id: "formField-phoneNumber", value: phone },
    ];

    for (const fieldDef of textFieldsToFill) {
      fillFormField(fieldDef.id, fieldDef.value);
    }

    // Also try legacy selectors (some older Workday instances use different IDs)
    fillLegacyWorkdayInput("legalNameSection_firstName", firstName);
    fillLegacyWorkdayInput("legalNameSection_lastName", lastName);
    fillLegacyWorkdayInput("email", email);
    fillLegacyWorkdayInput("phone-number", phone);
    fillLegacyWorkdayInput("addressSection_addressLine1", address);
    fillLegacyWorkdayInput("addressSection_city", city);
    fillLegacyWorkdayInput("addressSection_postalCode", postalCode);

    // Single sleep after all text fields
    await sleep(500);

    // Field validation: read back values and retry any that didn't stick
    await validateAndRetryTextFields(textFieldsToFill);

    // Label-text fallback: for Workday instances with non-standard automation IDs,
    // scan all visible labels and fill matched inputs directly.
    const labelFallbacks = [
      { labels: ["first name", "legal first name", "given name", "prénom"], value: firstName },
      { labels: ["last name", "legal last name", "family name", "surname", "nom"], value: lastName },
      { labels: ["email", "e-mail", "email address", "courriel"], value: email },
      { labels: ["phone", "phone number", "telephone", "mobile", "cell"], value: phone },
      { labels: ["city", "city of residence", "municipality", "ville"], value: city },
      { labels: ["address line 1", "street address", "street", "address"], value: address },
      { labels: ["postal code", "zip code", "zip", "postcode"], value: postalCode },
    ];
    for (const fb of labelFallbacks) {
      fillByLabelText(fb.labels, fb.value);
    }

    await sleep(300);

    // PARALLEL DROPDOWN FILLING: Fill all dropdowns in parallel
    LOG("Filling dropdowns in parallel...");

    const dropdownPromises = [];

    // "How Did You Hear About Us?" — scan all formField containers by label first.
    // Companies use different field IDs (formField-source, formField-hearAboutUs, etc.)
    // and different option lists, so we search broadly then pick the best available option.
    {
      const hearKeywords = ["how did you hear", "how did you find out", "how did you learn", "source of hire", "referral source", "source of referral"];
      let hearFieldId = null;
      const allFf = document.querySelectorAll('[data-automation-id^="formField-"]');
      for (const ff of allFf) {
        const lbl = (ff.querySelector("label")?.textContent?.trim() || "").toLowerCase();
        if (hearKeywords.some(kw => lbl.includes(kw))) {
          hearFieldId = ff.getAttribute("data-automation-id");
          LOG(`Found "How Did You Hear" field: ${hearFieldId} ("${lbl.substring(0,50)}")`);
          break;
        }
      }
      if (hearFieldId) {
        const hearField = document.querySelector(`[data-automation-id="${hearFieldId}"]`);
        if (hearField?.querySelector("input")) {
          // Searchable field — try multiple terms in order of preference
          // Terms cover common option names across companies
          dropdownPromises.push(selectSearchableDropdown(hearFieldId,
            "Job Board", "LinkedIn", "Social Media", "Career Website",
            "Job Site", "Online", "Indeed", "Referral", "Other"));
        } else if (hearField?.querySelector("button")) {
          dropdownPromises.push(selectDropdown(hearFieldId, "LinkedIn"));
        }
      }
      // If no "How Did You Hear" field found, skip — don't blindly call formField-source
      // (some Workday instances use formField-source for phone country code)
    }

    // Province/Territory
    if (province) {
      dropdownPromises.push(selectDropdown("formField-countryRegion", province));
    }

    // Phone Device Type — default to Mobile
    dropdownPromises.push(selectDropdown("formField-phoneType", "Mobile"));
    // Also try label-based fallback for non-standard phone type fields (e.g. BMO "Phone Device Type")
    dropdownPromises.push(selectDropdownByLabel(["phone device type", "phone type", "device type"], "Mobile"));

    // Wait for all dropdowns — use allSettled so one failure never blocks the others
    await Promise.allSettled(dropdownPromises);

    // ── Radio buttons on Step 1 (company-specific, e.g. "Have you worked for Airbus before?") ──
    // Answer "No" for any "previously/already worked for" questions on the info page.
    answerStep1RadioQuestions();

    // Give React/Workday time to process all field updates before we click Next.
    // Without this pause the Save and Continue click fires before Workday's form
    // validation has settled, causing the click to be silently ignored.
    await sleep(800);
    LOG("Step 1 filled");
  }

  /**
   * Answer Yes/No radio button questions that appear on the "My Information" step.
   * Companies like Airbus add custom questions here (e.g. "Have you already worked for Airbus?").
   */
  function answerStep1RadioQuestions() {
    const negativeKeywords = [
      "already worked for", "previously worked for", "have you worked for",
      "former employee", "currently employed by", "ever worked at",
      "have you ever worked", "previously employed",
      // "Have you worked with us before?" variants
      "worked with us before", "have you worked here", "worked here before",
      "previously worked with", "worked for this company", "worked for this organization",
      "been employed by", "been an employee",
    ];
    const positiveKeywords = [
      "eligible to work", "authorized to work", "right to work",
      "legally eligible", "at least 18", "at least 16",
    ];

    // Find all radio groups on the page
    const radioGroups = new Map();
    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      const name = radio.name || radio.getAttribute("data-automation-id") || "";
      if (!name) continue;
      if (!radioGroups.has(name)) radioGroups.set(name, []);
      radioGroups.get(name).push(radio);
    }

    for (const [name, radios] of radioGroups) {
      // Find the label for this radio group
      const groupLabel = (
        radios[0]?.closest('fieldset')?.querySelector('legend')?.textContent ||
        radios[0]?.closest('[data-automation-id]')?.querySelector('label')?.textContent ||
        radios[0]?.closest('div[class]')?.previousElementSibling?.textContent ||
        ""
      ).trim().toLowerCase();

      if (!groupLabel) continue;

      const wantYes = positiveKeywords.some(kw => groupLabel.includes(kw));
      const wantNo  = negativeKeywords.some(kw => groupLabel.includes(kw));
      if (!wantYes && !wantNo) continue;

      const target = wantYes ? "yes" : "no";
      for (const radio of radios) {
        const radioLabel = (
          radio.closest("label")?.textContent ||
          document.querySelector(`label[for="${radio.id}"]`)?.textContent ||
          radio.value || ""
        ).trim().toLowerCase();

        if (radioLabel.includes(target)) {
          if (!radio.checked) {
            radio.click();
            LOG(`Step 1 radio: "${groupLabel.substring(0, 50)}" → ${target}`);
          }
          break;
        }
      }
    }
  }

  /**
   * Select a Workday button-based dropdown by scanning label text on the page.
   * Useful for non-standard automation IDs.
   */
  async function selectDropdownByLabel(labelKeywords, value) {
    const fields = document.querySelectorAll('[data-automation-id^="formField-"]');
    for (const field of fields) {
      const labelEl = field.querySelector("label");
      // Workday App Questions: question text lives in a sibling div, not inside formField
      const siblingLabel = field.previousElementSibling?.textContent?.trim() ||
                           field.parentElement?.previousElementSibling?.textContent?.trim() || "";
      const labelText = (labelEl?.textContent?.trim() || siblingLabel || "").toLowerCase();
      if (!labelKeywords.some(kw => labelText.includes(kw.toLowerCase()))) continue;
      const fieldId = field.getAttribute("data-automation-id");
      if (fieldId) {
        await selectDropdown(fieldId, value);
        return;
      }
    }
  }

  /**
   * After filling text fields, read back their values and retry any that didn't stick.
   */
  async function validateAndRetryTextFields(fieldsToValidate) {
    const failedFields = [];

    for (const fieldDef of fieldsToValidate) {
      if (!fieldDef.value) continue;

      const field = document.querySelector(`[data-automation-id="${fieldDef.id}"]`);
      if (!field) continue;

      const input = field.querySelector('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
      if (!input) continue;

      const currentValue = input.value?.trim() || "";
      if (currentValue !== fieldDef.value.trim()) {
        LOG(`Field ${fieldDef.id} didn't stick (got "${currentValue}", expected "${fieldDef.value}") — retrying...`);
        failedFields.push(fieldDef);
      }
    }

    // Retry failed fields
    if (failedFields.length > 0) {
      await sleep(200);
      for (const fieldDef of failedFields) {
        fillFormField(fieldDef.id, fieldDef.value);
      }
      await sleep(300);
    }

    if (failedFields.length > 0) {
      LOG(`Retried ${failedFields.length} fields that didn't stick initially`);
    }
  }

  /* ═══════════════════ STEP 2: MY EXPERIENCE ═══════════════════ */

  async function fillStep2(tailoredResult, job) {
    // Kept for backward-compat — delegates to fillStep2ExtraFields
    await fillStep2ExtraFields(tailoredResult, job);
    LOG("Step 2 filled");
  }

  /**
   * Upload resume programmatically on Step 2.
   * Uses keyed lookup via GET_RESUME_PDF so batch jobs always upload the correct resume.
   */
  async function uploadResumeProgrammatically() {
    try {
      // Keyed lookup: get the PDF that matches THIS tab's pending job
      const pendingData = await chrome.storage.local.get(["pendingApplication", "lastTailoredJob"]);
      const job = pendingData.pendingApplication || pendingData.lastTailoredJob;
      const pdfResult = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: "GET_RESUME_PDF", job: job || {} }, resolve)
      );
      const base64Pdf = pdfResult?.pdf;

      if (!base64Pdf) {
        LOG("No tailored resume PDF found in storage");
        return false;
      }
      LOG("Resume PDF found (key:", pdfResult.fromKey ? "matched" : "fallback", ")");

      // Find the file input — try both selectors
      let fileInput = document.querySelector('[data-automation-id="file-upload-input-ref"]');
      if (!fileInput) {
        fileInput = document.querySelector('input[type="file"]');
      }

      if (!fileInput) {
        LOG("Could not find file input for resume upload");
        return false;
      }

      // Decode base64 to Uint8Array
      const binaryString = atob(base64Pdf);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Create File object
      const file = new File([bytes], "resume.pdf", { type: "application/pdf" });

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
        await sleep(2000); // Wait for Workday to process upload
        // Verify the upload registered (Workday shows a file chip)
        const chip = document.querySelector('[data-automation-id="file-upload-item"], [data-automation-id="attachmentTitle"]');
        if (chip) {
          LOG("Upload confirmed — file chip appeared");
          return true;
        }
        LOG("React onChange fired but no file chip appeared — upload may not have worked");
        return false;
      } else {
        // Strategy 2: Fallback — Object.defineProperty + change event
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        Object.defineProperty(fileInput, "files", {
          value: dataTransfer.files,
          writable: true,
          configurable: true,
        });

        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        LOG("Resume uploaded via fallback (defineProperty + change event)");
        await sleep(2000);
        const chip = document.querySelector('[data-automation-id="file-upload-item"], [data-automation-id="attachmentTitle"]');
        if (chip) {
          LOG("Upload confirmed — file chip appeared");
          return true;
        }
        LOG("Fallback upload fired but no file chip appeared");
        return false;
      }

    } catch (err) {
      LOG(`Resume upload error: ${err.message}`);
      return false;
    }
  }

  /* ═══════════════════ STEP 3: APPLICATION QUESTIONS ═══════════════════ */

  async function fillStep3(tailoredResult, job) {
    LOG("Step 3 — Application Questions");
    await sleep(500);

    // Fill textareas (cover letter, why interested, etc.) — only needs tailored data
    if (tailoredResult) {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        if (ta.value?.trim()) continue; // Already filled

        const label = getFieldLabel(ta).toLowerCase();

        if (label.includes("cover") || label.includes("letter")) {
          setWorkdayValue(ta, tailoredResult.coverLetter || "");
        } else if (label.includes("why") || label.includes("interest") || label.includes("motivation")) {
          setWorkdayValue(ta, tailoredResult.coverLetter || "");
        } else if (label.includes("additional") || label.includes("anything else")) {
          setWorkdayValue(ta, tailoredResult.additionalInfo || "");
        } else {
          // Issue #6/#14: Unfilled open-ended question — attempt AI generation
          await generateAndFillBehavioralAnswer(ta, label, tailoredResult, job);
        }
      }
      await sleep(200);
    } else {
      LOG("No tailored result — skipping cover letter / textarea questions but continuing with standard HR dropdowns");
    }

    // ── DROPDOWN QUESTION FILLING ─────────────────────────────────────────────
    // Maps label keyword patterns → preferred answer option text.
    // selectDropdown() does a case-insensitive .includes() match on the option list,
    // so "Yes" matches "Yes (I am authorized)", "No" matches "No, I do not", etc.
    const dropdownAnswerRules = [
      // ── Work authorization (Canada-specific) ──────────────────────────────────
      // BMO / Canadian banks use long option text like "Canadian citizen, a Permanent Resident..."
      // Try "Permanent" first (matches PR option); falls back to "citizen" for citizens.
      // For generic Workday (US) where options are just "Yes" / "No", use "Yes".
      { keywords: ["legally eligible to work in canada", "eligible to work in canada", "right to work in canada", "work in canada"], answer: "Permanent" },
      // Generic work authorization (non-Canada Workday)
      { keywords: ["authorized to work", "legally authorized", "work authorization", "eligible to work", "right to work", "authorization to work"], answer: "Yes" },

      // ── Canadian identity / compliance (BMO, TD, RBC, Scotiabank, CIBC etc.) ──
      { keywords: ["valid social insurance number", "social insurance number (sin)", "social insurance number"], answer: "Yes" },
      { keywords: ["at least 16 years of age", "16 years of age", "minimum age"], answer: "Yes" },
      // Outside activities / conflicts of interest
      { keywords: ["outside activities", "outside business activities", "volunteer activities, employment", "outside employment", "business activities"], answer: "No" },
      // Internal audit / KPMG / Big4 affiliation
      { keywords: ["kpmg", "corporate auditor", "pwc", "deloitte", "ernst & young", "ey ", "big 4", "public accounting firm"], answer: "No" },
      // Current employer use of Workday
      { keywords: ["use or work on the workday system", "workday system", "use workday", "work on workday", "current job, do you use"], answer: "No" },
      // Previously worked at Workday — No
      { keywords: ["previously worked for or are you currently working for workday", "former workday", "workday as an employee or contractor"], answer: "No" },

      // ── Visa / immigration sponsorship — always No ────────────────────────────
      { keywords: ["sponsorship", "immigration filing", "visa sponsorship", "require any immigration", "work permit sponsorship", "permanent residency filing"], answer: "No" },

      // ── Relocation ────────────────────────────────────────────────────────────
      { keywords: ["consider relocating", "willing to relocate", "open to relocation", "relocation"], answer: "I am local" },

      // ── Non-compete / non-solicitation ────────────────────────────────────────
      { keywords: ["non-compete", "non-solicitation", "noncompete", "competitive restrictions", "restrictive covenant"], answer: "No" },

      // ── Years of experience ───────────────────────────────────────────────────
      { keywords: ["years of experience", "experience level", "years of relevant"], answer: tailoredResult?.yearsOfExperience || "5" },

      // ── Diversity & inclusion (voluntary — prefer "Prefer not to answer") ─────
      { keywords: ["gender identity", "gender identit"], answer: "Prefer not to answer" },
      { keywords: ["sexual orientation"], answer: "Prefer not to answer" },
      { keywords: ["visible minority", "racial minority", "racialized"], answer: "Prefer not to answer" },
      { keywords: ["indigenous", "aboriginal", "first nations", "inuit", "métis", "metis"], answer: "Prefer not to answer" },
      { keywords: ["disability", "require accommodation", "accommodation request", "person with a disability"], answer: "Prefer not to answer" },
      // Gender (broad match — must come AFTER more specific "gender identity")
      { keywords: ["what is your gender", "gender?"], answer: "Prefer not to answer" },

      // ── Canadian military ─────────────────────────────────────────────────────
      { keywords: ["canadian military", "military service", "armed forces", "veteran status"], answer: "No" },

      // ── US Government employee ────────────────────────────────────────────────
      { keywords: ["united states government", "us government employee", "current or former employee of the united states"], answer: "No" },

      // ── Export control countries ──────────────────────────────────────────────
      { keywords: ["export control", "iran, cuba", "north korea", "donetsk", "luhansk", "export control laws"], answer: "No" },

      // ── Related to Workday employee / customer employee / gov official ────────
      { keywords: ["related to a current workday employee", "are you related to a current workday"], answer: "No" },
      { keywords: ["related to an employee of a customer", "government official, who has direct business"], answer: "No" },

      // ── E&Y / audit firm affiliation ─────────────────────────────────────────
      // Note: "ernst & young" already matched above (line ~1003) but adding explicit full match
      { keywords: ["workday's independent auditors", "principal of ernst & young", "principal of ernst and young"], answer: "No" },

      // ── NDA / Non-Disclosure Agreement ───────────────────────────────────────
      // NOTE: answer must NOT contain "do not" — selectDropdown does .includes() match
      { keywords: ["non disclosure agreement", "read and agree to the non disclosure", "nda agreement"], answer: "I have read and agree to the Non Disclosure" },

      // ── Mutual Arbitration Agreement ─────────────────────────────────────────
      { keywords: ["mutual arbitration agreement", "agree to the mutual arbitration"], answer: "I have read and agree to the Mutual Arbitration" },

      // ── Acknowledgment / certification questions ──────────────────────────────
      // These are "I acknowledge that I have read and answered truthfully" dropdowns.
      // Selecting "No" disqualifies the application — must be "Yes".
      { keywords: ["i acknowledge that i have read", "i have answered them truthfully", "acknowledge that i have read, understood"], answer: "Yes" },
    ];

    const formFields = document.querySelectorAll('[data-automation-id^="formField-"]');
    const dropdownPromises = [];

    for (const field of formFields) {
      const labelEl = field.querySelector("label");
      // Workday Application Questions: question text lives in a sibling div outside the
      // formField container — not in a <label> inside it. Check both locations.
      const siblingLabel = field.previousElementSibling?.textContent?.trim() ||
                           field.parentElement?.previousElementSibling?.textContent?.trim() || "";
      const label = (labelEl?.textContent?.trim() || siblingLabel || "").toLowerCase();
      if (!label) continue;

      // Only target button-based dropdowns (Workday custom selects)
      const btn = field.querySelector("button");
      if (!btn) continue;

      // Skip if already has a value (not showing "Select One" / "Select")
      const currentText = (btn.textContent?.trim() || "").toLowerCase();
      if (currentText && !currentText.includes("select")) {
        LOG(`Dropdown already filled: "${label.substring(0, 50)}" = "${currentText.substring(0, 30)}"`);
        continue;
      }

      const fieldId = field.getAttribute("data-automation-id");

      // Find matching rule
      let matched = false;
      for (const rule of dropdownAnswerRules) {
        if (rule.keywords.some(kw => label.includes(kw.toLowerCase()))) {
          LOG(`Matched dropdown: "${label.substring(0, 60)}" → "${rule.answer}"`);
          dropdownPromises.push(selectDropdown(fieldId, rule.answer));
          matched = true;
          break;
        }
      }

      if (!matched) {
        LOG(`Unmatched dropdown question: "${label.substring(0, 80)}" — skipping`);
      }
    }

    // Also handle radio-button style Yes/No questions (some Workday variants use these)
    const radioPromises = [
      answerYesNoQuestion("authorized to work", true),
      answerYesNoQuestion("legally authorized", true),
      answerYesNoQuestion("require sponsorship", false),
      answerYesNoQuestion("willing to relocate", true),
      answerYesNoQuestion("workday system", false),
      answerYesNoQuestion("immigration", false),
      answerYesNoQuestion("visa sponsorship", false),
      answerYesNoQuestion("non-compete", false),
      answerYesNoQuestion("non-solicitation", false),
      answerYesNoQuestion("previously worked for", false),
      answerYesNoQuestion("worked with us before", false),
      answerYesNoQuestion("worked here before", false),
      answerYesNoQuestion("been employed by", false),
      answerYesNoQuestion("have you worked with us", false),
    ];

    await Promise.allSettled([...dropdownPromises, ...radioPromises]);

    // ── Compensation / salary text inputs ─────────────────────────────────────
    // Some Workday instances render compensation as a plain text field rather than a dropdown.
    const profile = await chrome.storage.local.get(["userProfile", "parsedResume"]);
    const user = profile.userProfile || {};
    const maxPay = extractMaxPayFromJD(job?.jobDescription) || user.salaryExpectation || user.compensation || "";
    if (maxPay) {
      const compLabels = ["compensation", "salary expectation", "desired salary", "expected salary", "pay expectation", "base salary"];
      fillByLabelText(compLabels, maxPay);
    }

    // ── Name signature field (Application Questions 2 of 2 pattern) ───────────
    // "Please enter your name" — required for NDA / Arbitration agreement signing.
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    if (fullName) {
      // Try standard label-based fill first
      const filled = fillByLabelText(
        ["please enter your name", "your name", "full name", "print name", "signature name", "enter your name"],
        fullName
      );
      if (!filled) {
        // Fallback: scan formFields whose container text contains "name"
        for (const field of document.querySelectorAll('[data-automation-id^="formField-"]')) {
          const containerText = (
            field.previousElementSibling?.textContent ||
            field.parentElement?.previousElementSibling?.textContent || ""
          ).toLowerCase();
          if (!containerText.includes("your name") && !containerText.includes("enter your name") &&
              !containerText.includes("full name") && !containerText.includes("print name")) continue;
          const ta = field.querySelector('textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])');
          if (ta && !ta.value?.trim()) {
            setWorkdayValue(ta, fullName);
            LOG(`Filled name field via container text scan: "${fullName}"`);
            break;
          }
        }
      } else {
        LOG(`Filled name field via fillByLabelText: "${fullName}"`);
      }
    } else {
      LOG("No fullName in userProfile — skipping name signature field");
    }

    // ── Today's date field (Application Questions 2 of 2 pattern) ────────────
    // "Please enter today's date" — date picker with Month/Day/Year spinbuttons.
    await fillTodayDateFields();

    LOG("Step 3 filled");
  }

  /**
   * Issue #6/#14: Generate a behavioral answer for an unfilled textarea using AI
   */
  async function generateAndFillBehavioralAnswer(textarea, label, tailoredResult, job) {
    try {
      // Don't attempt generation for very short labels (likely errors)
      if (!label || label.length < 5) return;

      // Get resume summary from tailoredResult if available
      const resumeText = tailoredResult?.tailoredResume
        ? `${job?.jobTitle || ""} experience: ${tailoredResult.tailoredResume}`.substring(0, 200)
        : "";

      LOG(`Generating behavioral answer for: "${label.substring(0, 50)}..."`);

      // Send to background script to call the AI API
      const result = await sendMessageWithTimeout({
        type: "GENERATE_BEHAVIORAL_ANSWER",
        question: label,
        jobTitle: job?.jobTitle || "",
        company: job?.company || "",
        jobDescription: job?.jobDescription?.substring(0, 500) || "",
        resumeText: resumeText,
      }, 60000); // 60 second timeout for AI generation

      if (result?.error) {
        LOG(`Failed to generate answer: ${result.error}`);
        return;
      }

      if (result?.answer) {
        LOG(`Generated answer (${result.answer.length} chars) for: "${label.substring(0, 30)}..."`);
        setWorkdayValue(textarea, result.answer);
      }
    } catch (err) {
      LOG(`Error generating behavioral answer: ${err.message}`);
      // Graceful degradation — if AI generation fails, just skip this field
    }
  }

  /** Fill unfilled date-picker spinbutton groups with today's date (MM/DD/YYYY). */
  async function fillTodayDateFields() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day   = String(today.getDate()).padStart(2, "0");
    const year  = String(today.getFullYear());

    const fields = document.querySelectorAll('[data-automation-id^="formField-"]');
    for (const field of fields) {
      const spinners = field.querySelectorAll('[role="spinbutton"]');
      if (spinners.length < 2) continue;

      const monthS = Array.from(spinners).find(s => s.getAttribute("aria-label") === "Month");
      const dayS   = Array.from(spinners).find(s => s.getAttribute("aria-label") === "Day");
      const yearS  = Array.from(spinners).find(s => s.getAttribute("aria-label") === "Year");
      if (!monthS || !dayS) continue;

      // Skip if Day is already set
      if (dayS.getAttribute("aria-valuenow")) continue;

      LOG("Filling date field with today's date");

      // Focus and type into each spinbutton — Workday date pickers respond to keydown
      const typeIntoSpinner = async (spinner, text) => {
        spinner.focus();
        await sleep(80);
        for (const ch of text) {
          ["keydown", "keypress", "keyup"].forEach(evType => {
            spinner.dispatchEvent(new KeyboardEvent(evType, {
              key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0),
              which: ch.charCodeAt(0), bubbles: true, cancelable: true
            }));
          });
          await sleep(30);
        }
      };

      await typeIntoSpinner(monthS, month);
      await typeIntoSpinner(dayS, day);
      if (yearS) await typeIntoSpinner(yearS, year);
      await sleep(100);
      return true;
    }
    return false;
  }

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

  /**
   * Extract pay range from a JD string as a formatted label, e.g. "$120K–$190K".
   * Returns null if no salary found.
   */
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

  /** Store salary range into _aa_batchProgress so showBanner can display it. */
  function storeSalaryRangeInProgress(salaryRange) {
    if (!salaryRange) return;
    chrome.storage.local.get(["_aa_batchProgress"], ({ _aa_batchProgress: bp }) => {
      if (bp) chrome.storage.local.set({ _aa_batchProgress: { ...bp, salaryRange } });
    });
  }

  /* ═══════════════════ MY EXPERIENCE PAGE FILLING ═══════════════════ */

  /**
   * Fill Work Experience, Education, and Certification sections on Step 2.
   * Called after resume upload is confirmed, before clicking Next.
   */
  async function fillMyExperiencePage(tailoredResult, pendingJob) {
    const stored = await chrome.storage.local.get(["parsedResume", "userProfile"]);
    const resume = stored.parsedResume || {};

    // Debug logging for work experience sources
    LOG(`fillMyExperiencePage: parsedResume.workExperience length = ${resume.workExperience?.length || 0}`);
    LOG(`fillMyExperiencePage: tailoredResult.workExperience length = ${tailoredResult?.workExperience?.length || 0}`);
    if (tailoredResult?.workExperience?.length > 0) {
      LOG(`fillMyExperiencePage: tailoredResult work exp: ${JSON.stringify(tailoredResult.workExperience.map(w => w.role || w.title))}`);
    }

    // If parsedResume has no work experience, fall back to tailoredResult (the AI-tailored copy
    // of the resume). This covers cases where the original parsing missed the work history.
    const workExp = resume.workExperience?.length > 0
      ? resume.workExperience
      : (tailoredResult?.workExperience || []);
    const education = resume.education?.length > 0
      ? resume.education
      : (tailoredResult?.education || []);
    const certifications = resume.certifications?.length > 0
      ? resume.certifications
      : (tailoredResult?.certifications || []);
    // skills can be a flat array OR an object { technical, soft, tools }
    const rawSkills = resume.skills || [];
    const skills = Array.isArray(rawSkills)
      ? rawSkills
      : [
          ...(rawSkills.technical || []),
          ...(rawSkills.tools || []),
          ...(rawSkills.soft || [])
        ];

    const weSrc = resume.workExperience?.length > 0 ? "parsedResume" : "tailoredResult";
    LOG(`fillMyExperiencePage: ${workExp.length} work (${weSrc}), ${education.length} edu, ${certifications.length} certs, ${skills.length} skills`);

    if (workExp.length > 0) {
      LOG(`Calling fillWorkExperienceEntries with ${workExp.length} entries`);
      await fillWorkExperienceEntries(workExp);
    } else {
      LOG(`WARNING: No work experience to fill after fallback check!`);
    }
    if (education.length > 0) await fillEducationEntries(education);

    // ── Certifications ────────────────────────────────────────────────────────
    if (certifications.length > 0) {
      await fillCertificationEntries(certifications);
    }

    // ── Skills ────────────────────────────────────────────────────────────────
    if (skills.length > 0) {
      await fillSkillsField(skills);
    }
  }

  /**
   * Fill the Certifications section by clicking "Add" for each certification.
   */
  async function fillCertificationEntries(certifications) {
    LOG(`Filling ${certifications.length} certification(s)`);
    for (let i = 0; i < certifications.length; i++) {
      const cert = typeof certifications[i] === "string"
        ? { name: certifications[i] }
        : certifications[i];

      // Click "Add" (first cert) or "Add Another" (subsequent)
      const addBtn = findSectionAddButton("certifications", i > 0) ||
                     findSectionAddButton("certification", i > 0);
      if (!addBtn) { LOG(`No Add button for cert ${i + 1} — stopping`); break; }
      addBtn.click();
      await sleep(1200);

      // Find the most recently added container
      const containers = findExperienceContainers("certif");
      const container = containers[containers.length - 1];
      if (!container) continue;

      await fillLabeledFieldInBlock(container, ["certification", "name", "title", "license"], cert.name || cert);
      if (cert.issuer) {
        await fillLabeledFieldInBlock(container, ["issuer", "issued by", "organization", "authority"], cert.issuer);
      }
      if (cert.date || cert.year) {
        await fillLabeledFieldInBlock(container, ["date", "issued", "completion date", "year"], cert.date || String(cert.year));
      }
    }
  }

  /**
   * Fill the Skills tag-input field on the My Experience page.
   * Workday uses a multi-select combobox where you type a skill and pick from dropdown.
   * Fixed to prevent infinite loops by:
   * 1. Clearing the input after each skill
   * 2. Waiting for dropdown with timeout
   * 3. Tracking attempted skills to avoid retries
   */
  async function fillSkillsField(skills) {
    LOG(`Filling ${skills.length} skill(s) in Skills field`);

    // Find the skills input — it's typically a combobox or text input near "Skills" heading
    const skillsInput = document.querySelector('[data-automation-id*="skill"] input') ||
      document.querySelector('[aria-label*="skill" i]') ||
      document.querySelector('[placeholder*="skill" i]') ||
      (() => {
        // Walk through all formField containers to find one labelled "skills"
        for (const ff of document.querySelectorAll('[data-automation-id^="formField-"]')) {
          const lbl = (ff.querySelector("label")?.textContent || ff.previousElementSibling?.textContent || "").toLowerCase();
          if (lbl.includes("skill")) {
            return ff.querySelector('input, [role="combobox"]');
          }
        }
        return null;
      })();

    if (!skillsInput) {
      LOG("Skills input not found — skipping");
      return;
    }

    const attemptedSkills = new Set();
    const MAX_ATTEMPTS = skills.length;
    let attemptCount = 0;

    // Type each skill and either press Enter or pick from dropdown
    for (const skill of skills.slice(0, 20)) { // cap at 20 to avoid spamming
      // Skip if we've already attempted this skill
      if (attemptedSkills.has(skill)) {
        LOG(`Skipping skill "${skill}" — already attempted`);
        continue;
      }
      attemptedSkills.add(skill);
      attemptCount++;

      if (attemptCount > MAX_ATTEMPTS) {
        LOG(`Exceeded max skill attempts (${MAX_ATTEMPTS}) — stopping`);
        break;
      }

      LOG(`Filling skill ${attemptCount}/${skills.length}: "${skill}"`);
      skillsInput.focus();
      setWorkdayValue(skillsInput, skill);
      await sleep(600);

      // Wait for dropdown to appear with 2-second timeout
      let foundOption = false;
      let waitTimeMs = 0;
      while (waitTimeMs < 2000) {
        const option = document.querySelector('[role="option"], [data-automation-id*="promptOption"]');
        if (option) {
          LOG(`Found dropdown option for skill "${skill}" — selecting`);
          option.click();
          foundOption = true;
          await sleep(400);
          break;
        }
        await sleep(100);
        waitTimeMs += 100;
      }

      if (!foundOption) {
        // No dropdown appeared within timeout — try free-text entry with Enter
        LOG(`No dropdown for skill "${skill}" — trying Enter key`);
        skillsInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
        await sleep(200);
      }

      // Clear the input for the next skill
      setWorkdayValue(skillsInput, "");
      await sleep(100);
    }
    LOG(`Skills fill complete — filled ${attemptCount} skill(s)`);
  }

  /**
   * Extract the visible text from a button, ignoring SVG icons and aria-hidden elements.
   * Workday's Add buttons often contain "<svg>...</svg>Add" whose full textContent
   * would be "\n  Add\n" or "Add" but some instances render "+ Add" or have icon spans
   * that pollute textContent — this helper strips those before matching.
   */
  function buttonVisibleText(btn) {
    const clone = btn.cloneNode(true);
    clone.querySelectorAll('svg, [aria-hidden="true"], .icon, i').forEach(e => e.remove());
    return clone.textContent.replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * Find the "Add" or "Add Another" button for a named section (Work Experience / Education).
   * Significantly improved over previous version to handle Workday's SVG-icon buttons,
   * aria-label patterns, and deeper DOM hierarchies.
   */
  function findSectionAddButton(sectionKeyword, preferAnother = false) {
    const kwLower = sectionKeyword.toLowerCase();
    const kwSlug = kwLower.replace(/\s+/g, ""); // "workexperience"

    // ── Strategy 0: aria-label contains "add" + section keyword ──────────────
    // Workday often uses aria-label="Add Work Experience" or "Add another Work Experience"
    for (const btn of document.querySelectorAll("button[aria-label]")) {
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (!label.includes("add")) continue;
      const matchesSection = label.includes(kwLower) || label.includes(kwSlug) ||
        kwLower.split(" ").every(w => label.includes(w));
      if (!matchesSection) continue;
      const isAnother = /another/i.test(label);
      if (preferAnother && isAnother) return btn;
      if (!preferAnother && !isAnother) return btn;
    }

    // ── Strategy 1: data-automation-id contains section slug + "add" ─────────
    // e.g. data-automation-id="addWorkExperience" or "workExperienceAddButton"
    for (const btn of document.querySelectorAll("button[data-automation-id]")) {
      const autoId = (btn.getAttribute("data-automation-id") || "").toLowerCase();
      if (autoId.includes("add") && (autoId.includes(kwSlug) || autoId.includes(kwLower.replace(/\s/g, "")))) {
        return btn;
      }
    }

    // ── Strategy 2: Heading-proximity scan (improved depth + button text) ────
    const headings = Array.from(document.querySelectorAll(
      'h2, h3, h4, legend, [data-automation-id$="Section"], [data-automation-id*="section" i], div, span'
    )).filter(el => {
      // Only look at elements whose own label text (stripped of children's text) matches.
      // Use childNodes to get only direct text, falling back to full textContent for leaf nodes.
      let ownText = "";
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) ownText += node.textContent;
      }
      ownText = ownText.trim().toLowerCase();
      if (!ownText) ownText = (el.textContent || "").trim().toLowerCase();
      return (ownText === kwLower || ownText.startsWith(kwLower)) && ownText.length < kwLower.length + 10;
    });

    for (const heading of headings) {
      let section = heading.parentElement;
      for (let d = 0; d < 10 && section && section !== document.body; d++, section = section.parentElement) {
        const buttons = Array.from(section.querySelectorAll("button"));
        const addAnother = buttons.find(b => {
          const t = buttonVisibleText(b);
          const a = (b.getAttribute("aria-label") || "").toLowerCase();
          return /add another/i.test(t) || /add another/i.test(a);
        });
        const add = buttons.find(b => {
          const t = buttonVisibleText(b);
          const a = (b.getAttribute("aria-label") || "").toLowerCase();
          return /^add$/.test(t) || a === "add" || /^add a /i.test(a) || /^add row/i.test(a);
        });
        if (preferAnother && addAnother) return addAnother;
        if (!preferAnother && add) return add;
        if (addAnother || add) return addAnother || add;
      }
    }

    // ── Strategy 3: Any Add/Add Another button whose ancestor mentions keyword ─
    for (const btn of document.querySelectorAll("button")) {
      const t = buttonVisibleText(btn);
      const a = (btn.getAttribute("aria-label") || "").toLowerCase();
      const isAnother = /add another/i.test(t) || /add another/i.test(a);
      const isAdd = /^add$/.test(t) || a === "add" || /^add a /i.test(a);
      if (!isAnother && !isAdd) continue;
      let el = btn.parentElement;
      for (let d = 0; d < 10 && el && el !== document.body; d++, el = el.parentElement) {
        const elText = (el.textContent || "").toLowerCase();
        if (elText.includes(kwLower) || elText.includes(kwSlug)) {
          if (preferAnother && isAnother) return btn;
          if (!preferAnother && isAdd) return btn;
          if (isAdd || isAnother) return btn; // last-resort match
        }
      }
    }

    return null;
  }

  /**
   * Fill Work Experience form blocks.
   * Workday renders each entry as a named section ("Work Experience 1", etc.)
   * with Job Title, Company, Location, From, To, Role Description fields.
   * If the section starts empty (Airbus-style), clicks "Add" to create entries first.
   */
  /**
   * Wait until at least `minCount` work experience containers appear in the DOM,
   * polling every 300ms up to `maxMs`. Returns the found containers.
   */
  async function waitForWEContainers(minCount, maxMs = 5000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const c = findExperienceContainers("work");
      if (c.length >= minCount) return c;
      await sleep(300);
    }
    return findExperienceContainers("work");
  }

  async function fillWorkExperienceEntries(workExp) {
    // Find work experience entry containers using multiple strategies
    let containers = findExperienceContainers("work");
    LOG(`Work experience: found ${containers.length} containers for ${workExp.length} entries`);

    // If no containers found, section starts empty — click "Add" to create the first entry
    if (containers.length === 0) {
      const addBtn = findSectionAddButton("work experience");
      if (addBtn) {
        LOG("Clicking 'Add' to create first work experience entry");
        addBtn.click();
        // Poll until the container appears (up to 5s) — more reliable than fixed sleep
        containers = await waitForWEContainers(1, 5000);
        LOG(`After clicking Add: found ${containers.length} containers`);
      } else {
        LOG("No 'Add' button found for Work Experience — skipping (will try direct field scan)");
        // Last-ditch: maybe the form already has blank input rows not wrapped in containers
        // Attempt to fill by scanning the entire page for job-title-like inputs
        await fillWorkExperienceDirectScan(workExp);
        return;
      }
    }

    for (let i = 0; i < workExp.length; i++) {
      // For entries beyond the first, click "Add Another" to create a new block
      if (i > 0) {
        const prevCount = containers.length;
        const addAnother = findSectionAddButton("work experience", true) ||
                           findSectionAddButton("work experience", false);
        if (addAnother) {
          LOG(`Clicking 'Add Another' for WE entry ${i + 1}`);
          addAnother.click();
          // Wait for a new container to appear
          containers = await waitForWEContainers(prevCount + 1, 5000);
          if (containers.length <= prevCount) {
            LOG(`Add Another click didn't produce new container — stopping at ${i} entries`);
            break;
          }
        } else {
          LOG(`No 'Add Another' button for WE entry ${i + 1} — stopping at ${i} entries`);
          break;
        }
      }

      const container = containers[i];
      if (!container) break;
      const exp = workExp[i];
      // parsedResume stores job title as `role` (from prompts.ts schema).
      // Older snapshots may use `title`. Support both for backward compat.
      const jobTitle = exp.role || exp.title || "";
      LOG(`Filling WE ${i + 1}: "${jobTitle}" at "${exp.company}"`);

      // Job Title
      const titleFilled = await fillLabeledFieldInBlock(container, ["job title", "title", "position", "role"], jobTitle);
      if (!titleFilled) {
        // Try direct data-automation-id scan within container
        const titleInput = container.querySelector(
          '[data-automation-id*="jobTitle" i] input, [data-automation-id*="title" i] input, [placeholder*="title" i]'
        );
        if (titleInput && !titleInput.value?.trim()) { setWorkdayValue(titleInput, jobTitle); await sleep(80); }
      }

      // Company
      const compFilled = await fillLabeledFieldInBlock(container, ["company", "employer", "organization"], exp.company);
      if (!compFilled) {
        const compInput = container.querySelector(
          '[data-automation-id*="company" i] input, [data-automation-id*="employer" i] input, [placeholder*="company" i]'
        );
        if (compInput && !compInput.value?.trim()) { setWorkdayValue(compInput, exp.company); await sleep(80); }
      }

      // Location
      if (exp.location) {
        await fillLabeledFieldInBlock(container, ["location", "city"], exp.location);
      }

      // "I currently work here" checkbox
      const isCurrent = !exp.endDate ||
        /^(present|current|now|today)$/i.test(String(exp.endDate).trim());

      if (isCurrent) {
        const checkbox = findCurrentJobCheckbox(container);
        if (checkbox && !checkbox.checked) {
          checkbox.click();
          await sleep(400);
        }
      }

      // From date
      const fromMMYYYY = parseToMMYYYY(exp.startDate);
      if (fromMMYYYY) {
        await fillDateFieldInBlock(container, ["from", "start date", "start"], fromMMYYYY);
      }

      // To date (skip if current job — Workday hides or disables it)
      if (!isCurrent && exp.endDate) {
        const toMMYYYY = parseToMMYYYY(exp.endDate);
        if (toMMYYYY) {
          await fillDateFieldInBlock(container, ["to", "end date", "end"], toMMYYYY);
        }
      }

      // Role Description — try textarea first, then contenteditable
      const textarea = container.querySelector("textarea");
      if (textarea && !textarea.value?.trim() && exp.description) {
        setWorkdayValue(textarea, exp.description);
        await sleep(100);
      } else if (!textarea && exp.description) {
        const ce = container.querySelector('[contenteditable="true"]');
        if (ce && !ce.textContent?.trim()) {
          ce.focus();
          document.execCommand("insertText", false, exp.description);
          await sleep(100);
        }
      }

      await sleep(400);
    }

    LOG(`fillWorkExperienceEntries: completed ${Math.min(workExp.length, containers.length)} entries`);
  }

  /**
   * Fallback: when no containers and no Add button found, try to fill work experience
   * fields directly by scanning the page for any unfilled job-title inputs within
   * a section that mentions "work experience".
   */
  async function fillWorkExperienceDirectScan(workExp) {
    if (!workExp.length) return;
    LOG("fillWorkExperienceDirectScan: attempting direct field scan");

    // Find the work experience section by heading
    let weSection = null;
    for (const el of document.querySelectorAll('h2, h3, h4, legend, div, section')) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t.startsWith("work experience") && t.length < 25) {
        let parent = el.parentElement;
        for (let d = 0; d < 8 && parent && parent !== document.body; d++, parent = parent.parentElement) {
          if (parent.querySelectorAll('input, textarea').length >= 2) { weSection = parent; break; }
        }
        if (weSection) break;
      }
    }
    if (!weSection) { LOG("fillWorkExperienceDirectScan: no section found"); return; }

    const exp = workExp[0];
    const jobTitle = exp.role || exp.title || "";
    const inputs = Array.from(weSection.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])'));
    if (inputs[0] && !inputs[0].value?.trim()) { setWorkdayValue(inputs[0], jobTitle); await sleep(80); }
    if (inputs[1] && !inputs[1].value?.trim()) { setWorkdayValue(inputs[1], exp.company || ""); await sleep(80); }
    LOG(`fillWorkExperienceDirectScan: filled ${inputs.length} inputs`);
  }

  /**
   * Fill Education form blocks.
   * Handles both standard inputs and Airbus-style searchable autocomplete for School name.
   * If section starts empty, clicks "Add" to create entries first.
   * Fixed Issue #31: Only click "Add Another" when there's actually a next entry to fill,
   * and verify the new container exists before using it.
   */
  async function fillEducationEntries(education) {
    let containers = findExperienceContainers("education");
    LOG(`Education: found ${containers.length} containers for ${education.length} entries`);

    // If no containers found, try clicking "Add" (some Workday instances start empty)
    if (containers.length === 0) {
      const addBtn = findSectionAddButton("education");
      if (addBtn) {
        LOG("Clicking 'Add' to create first education entry");
        addBtn.click();
        await sleep(1500);
        containers = findExperienceContainers("education");
      }
    }

    for (let i = 0; i < education.length; i++) {
      // Check if we already have a container for this entry
      let container = containers[i];

      // For entries beyond the first, click "Add Another" ONLY if we don't have a container yet
      if (i > 0 && !container) {
        const addAnother = findSectionAddButton("education", true) ||
                           Array.from(document.querySelectorAll("button"))
                             .find(b => /add another/i.test(b.textContent));
        if (addAnother) {
          LOG(`Clicking 'Add Another' for Education entry ${i + 1}`);
          addAnother.click();
          await sleep(1500);
          containers = findExperienceContainers("education");
          container = containers[i]; // Re-fetch after the click
        } else {
          LOG(`No 'Add Another' for education entry ${i + 1} — stopping`);
          break;
        }
      }

      if (!container) {
        LOG(`Container for education entry ${i + 1} not found — stopping`);
        break;
      }
      const edu = education[i];
      LOG(`Filling Education ${i + 1}: "${edu.degree}" at "${edu.school}"`);

      // School / University — try standard fill first, then searchable autocomplete
      const schoolFilled = await fillLabeledFieldInBlock(container, ["school", "institution", "university", "college", "school or university"], edu.school);
      if (!schoolFilled) {
        // Airbus-style: searchable autocomplete — type partial name, wait for suggestions, press Enter
        await fillSearchableAutocomplete(container, ["school", "institution", "university", "college", "school or university"], edu.school);
      }

      // Degree — normalise first so "MBA"→"Masters", "B.Com"→"Bachelors", etc.
      const degreeNormalized = normalizeDegreeForWorkday(edu.degree);
      await fillLabeledFieldInBlock(container, ["degree", "qualification", "degree level"], degreeNormalized);
      // Try dropdown select by normalized degree keyword
      const degreeField = findFieldByLabelInContainer(container, ["degree", "qualification"]);
      if (degreeField) {
        const select = degreeField.querySelector("select") || container.querySelector("select");
        if (select) {
          fillSelectByKeyword(select, degreeNormalized);
        } else {
          // Button-based Workday dropdown for degree
          const fieldAutoId = degreeField.getAttribute?.("data-automation-id");
          if (fieldAutoId) await selectDropdown(fieldAutoId, degreeNormalized);
        }
      }

      // Field of Study — also often a searchable autocomplete on Airbus
      const fos = edu.fieldOfStudy || edu.major;
      if (fos) {
        const fosFilled = await fillLabeledFieldInBlock(container, ["field of study", "major", "area of study", "discipline"], fos);
        if (!fosFilled) {
          await fillSearchableAutocomplete(container, ["field of study", "major", "area of study"], fos);
        }
      }

      if (edu.gpa) await fillLabeledFieldInBlock(container, ["gpa", "grade", "grade point"], edu.gpa);

      const fromMMYYYY = parseToMMYYYY(edu.startDate);
      if (fromMMYYYY) await fillDateFieldInBlock(container, ["from", "start date", "start"], fromMMYYYY);

      const isCurrent = !edu.endDate || /^(present|current)$/i.test(String(edu.endDate).trim());
      if (!isCurrent && edu.endDate) {
        const toMMYYYY = parseToMMYYYY(edu.endDate);
        if (toMMYYYY) await fillDateFieldInBlock(container, ["to", "end date", "end", "graduation"], toMMYYYY);
      }

      await sleep(300);
    }
  }

  /**
   * Normalise a degree string to the canonical Workday dropdown values:
   * No Degree | Diploma | Associates | Bachelors | Masters | Doctorate
   */
  function normalizeDegreeForWorkday(degree) {
    if (!degree) return degree;
    const d = degree.toLowerCase().trim();
    if (/phd|ph\.d|doctorate/.test(d)) return "Doctorate";
    if (/mba|master|m\.s\.|m\.a\.|m\.eng|msc|m\.sc|mphil|m\.ed/.test(d)) return "Masters";
    if (/bachelor|b\.s\.|b\.a\.|b\.com|b\.eng|b\.sc|b\.tech|hons|honours/.test(d)) return "Bachelors";
    if (/associate/.test(d)) return "Associates";
    if (/diploma|certificate|pg\s*dip/.test(d)) return "Diploma";
    // Generic fallback: if the raw word appears in a known option, use it
    for (const canonical of ["Doctorate","Masters","Bachelors","Associates","Diploma"]) {
      if (canonical.toLowerCase().includes(d) || d.includes(canonical.toLowerCase())) return canonical;
    }
    return degree; // Return as-is — caller will do best-effort match
  }

  /**
   * Fill a searchable autocomplete field (type text → wait for suggestion → Enter/click).
   * Used for Airbus-style "School or University" and "Field of Study" fields.
   */
  async function fillSearchableAutocomplete(container, labelKeywords, value) {
    if (!value) return;
    const input = findInputByLabelInBlock(container, labelKeywords);
    if (!input) return;

    // Type the first ~30 chars to trigger autocomplete
    const query = value.substring(0, 30);
    setWorkdayValue(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(1200); // Wait for suggestions to load

    // Try to click the first suggestion in the dropdown list
    const listbox = document.querySelector('[role="listbox"], [data-automation-id*="promptOption"], ul[class*="suggest"]');
    if (listbox) {
      const firstOpt = listbox.querySelector('[role="option"], li');
      if (firstOpt) {
        firstOpt.click();
        LOG(`Autocomplete: selected "${firstOpt.textContent?.trim().substring(0, 40)}" for "${labelKeywords[0]}"`);
        await sleep(400);
        return;
      }
    }

    // No suggestions — type "Other" and press Enter (Airbus fallback)
    setWorkdayValue(input, "Other");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(800);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    await sleep(400);
    LOG(`Autocomplete: no suggestions found for "${value}", used "Other"`);
  }

  /**
   * Find a form field container within a block by label keywords.
   */
  function findFieldByLabelInContainer(container, labelKeywords) {
    const fields = container.querySelectorAll('[data-automation-id^="formField-"]');
    for (const field of fields) {
      const label = (field.querySelector("label")?.textContent || "").toLowerCase();
      if (labelKeywords.some(kw => label.includes(kw.toLowerCase()))) return field;
    }
    return null;
  }

  /**
   * Fill a <select> by matching option text against a keyword (case-insensitive).
   */
  function fillSelectByKeyword(select, keyword) {
    if (!keyword) return;
    const kw = keyword.toLowerCase();
    for (const opt of select.options) {
      if (opt.text.toLowerCase().includes(kw) || kw.includes(opt.text.toLowerCase().replace(/^[a-z]{2}\s*[-–]\s*/i, ""))) {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        LOG(`Select: chose "${opt.text}" for keyword "${keyword}"`);
        return;
      }
    }
  }

  /**
   * Find all entry containers (Work Experience or Education blocks) on the page.
   * Uses a cascade of strategies since Workday DOM structure varies.
   */
  function findExperienceContainers(type) {
    const isWork = type === "work";
    const sectionKeywords = isWork ? ["work experience", "employment", "job"] : ["education", "schooling", "academic"];
    const entryPattern = isWork ? /work experience\s+\d+/i : /education\s+\d+/i;

    // Strategy 1: Workday data-automation-id numbered entries
    // e.g. [data-automation-id="workExperience-0"], [data-automation-id="education-0"]
    const autoIdPrefix = isWork ? "workExperience" : "education";
    const byId = Array.from(document.querySelectorAll(
      `[data-automation-id^="${autoIdPrefix}-"], [data-automation-id*="WorkExperience--"], [data-automation-id*="Education--"]`
    )).filter(el => !el.querySelector(`[data-automation-id^="${autoIdPrefix}-"]`)); // exclude nested matches

    if (byId.length > 0) {
      LOG(`findExperienceContainers(${type}): Strategy 1 found ${byId.length}`);
      return byId;
    }

    // Strategy 2: Find by "Work Experience N" / "Education N" heading text
    const headingContainers = [];
    const allText = document.querySelectorAll('h2, h3, h4, legend, span, div');
    for (const el of allText) {
      const text = (el.textContent?.trim() || "");
      if (!entryPattern.test(text)) continue;
      if (text.length > 40) continue; // Skip broad containers that just happen to contain the phrase

      // Walk up to find a block container (has multiple inputs)
      let container = el.parentElement;
      let depth = 0;
      while (container && container !== document.body && depth < 8) {
        const inputs = container.querySelectorAll('input:not([type="hidden"]), textarea');
        if (inputs.length >= 2) break;
        container = container.parentElement;
        depth++;
      }
      if (container && container !== document.body && !headingContainers.includes(container)) {
        headingContainers.push(container);
      }
    }

    if (headingContainers.length > 0) {
      LOG(`findExperienceContainers(${type}): Strategy 2 found ${headingContainers.length}`);
      return headingContainers;
    }

    // Strategy 3: Find by "Job Title" / "School" label presence
    // Each block has a unique "Job Title" or "School" label — find those inputs
    // and collect their parent block containers
    const anchorLabel = isWork ? ["job title", "title"] : ["school", "institution", "university"];
    const anchorInputs = findAllLabeledInputs(anchorLabel);
    const byAnchor = [];

    for (const input of anchorInputs) {
      let container = input.parentElement;
      let depth = 0;
      while (container && container !== document.body && depth < 10) {
        // Look for a container that has "Company" / "School" label inside
        const labels = Array.from(container.querySelectorAll("label"));
        const hasAnchor = labels.some(l => {
          const t = (l.textContent?.trim() || "").toLowerCase();
          return isWork ? t.includes("company") || t.includes("employer") : t.includes("degree") || t.includes("school");
        });
        if (hasAnchor && container.querySelectorAll('input, textarea').length >= 3) break;
        container = container.parentElement;
        depth++;
      }
      if (container && container !== document.body && !byAnchor.includes(container)) {
        byAnchor.push(container);
      }
    }

    LOG(`findExperienceContainers(${type}): Strategy 3 found ${byAnchor.length}`);
    return byAnchor;
  }

  /**
   * Find all inputs whose label contains one of the given keywords, anywhere on the page.
   */
  function findAllLabeledInputs(labelKeywords) {
    const result = [];
    for (const label of document.querySelectorAll("label")) {
      const text = (label.textContent?.trim() || "").toLowerCase();
      if (!labelKeywords.some(kw => text.includes(kw.toLowerCase()))) continue;
      const forId = label.getAttribute("for");
      let input = forId ? document.getElementById(forId) : null;
      if (!input) input = label.querySelector('input:not([type="hidden"]):not([type="file"])');
      if (input) result.push(input);
    }
    return result;
  }

  /**
   * Within a container block, find an input whose label contains one of the given keywords.
   * Returns the input element or null.
   */
  function findInputByLabelInBlock(container, labelKeywords) {
    for (const label of container.querySelectorAll("label")) {
      const text = (label.textContent?.trim() || "").toLowerCase();
      if (!labelKeywords.some(kw => text.includes(kw.toLowerCase()))) continue;
      const forId = label.getAttribute("for");
      let input = forId ? document.getElementById(forId) : null;
      if (!input) input = label.closest('[data-automation-id]')?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
      if (!input) input = label.parentElement?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
      if (input) return input;
    }
    // Also try data-automation-id scan within container
    for (const kw of labelKeywords) {
      const el = container.querySelector(`[data-automation-id*="${kw}" i] input, [placeholder*="${kw}" i]`);
      if (el) return el.tagName === "INPUT" ? el : el.querySelector('input');
    }
    return null;
  }

  /** Fill a labeled text field within a container block, if it's empty. */
  async function fillLabeledFieldInBlock(container, labelKeywords, value) {
    if (!value) return false;
    const input = findInputByLabelInBlock(container, labelKeywords);
    if (!input || input.value?.trim()) return false;
    setWorkdayValue(input, String(value));
    await sleep(80);
    return true;
  }

  /**
   * Fill a date field (MM/YYYY format) within a container block.
   * Workday date fields are text inputs that accept "MM/YYYY".
   */
  async function fillDateFieldInBlock(container, labelKeywords, mmYYYY) {
    if (!mmYYYY) return false;
    const input = findInputByLabelInBlock(container, labelKeywords);
    if (!input || input.value?.trim()) return false;

    // Set value using setWorkdayValue
    setWorkdayValue(input, mmYYYY);
    await sleep(100);

    // If Workday didn't accept it, try simulating keypresses digit-by-digit
    if (!input.value?.trim()) {
      input.focus();
      for (const ch of mmYYYY.replace("/", "")) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
        input.value += ch;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        await sleep(30);
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    return true;
  }

  /** Find the "I currently work here" checkbox within a work experience block. */
  function findCurrentJobCheckbox(container) {
    return Array.from(container.querySelectorAll('input[type="checkbox"]')).find(cb => {
      const labelEl = cb.closest("label") || document.querySelector(`label[for="${cb.id}"]`);
      const text = (labelEl?.textContent?.trim() || "").toLowerCase();
      return text.includes("currently") || text.includes("present") || text.includes("still work");
    });
  }

  /**
   * Parse a date string to MM/YYYY format.
   * Handles: ISO (2020-01), natural language (January 2020), year-only (2020).
   * Returns null for "Present", "Current", or unparseable strings.
   */
  function parseToMMYYYY(dateStr) {
    if (!dateStr) return null;
    const d = String(dateStr).trim();
    if (/^(present|current|now|today)$/i.test(d)) return null;

    // ISO: 2020-01 or 2020-01-15
    const iso = d.match(/^(\d{4})-(\d{2})/);
    if (iso) return `${iso[2]}/${iso[1]}`;

    // Year only: 2020
    const yearOnly = d.match(/^(\d{4})$/);
    if (yearOnly) return `01/${yearOnly[1]}`;

    // Month Year: "January 2020", "Jan 2020", "jan 2020"
    const months = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
                      jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
    const mY = d.match(/^([a-zA-Z]+)\.?\s+(\d{4})/);
    if (mY) {
      const mon = months[mY[1].substring(0, 3).toLowerCase()];
      if (mon) return `${mon}/${mY[2]}`;
    }

    // Year Month: "2020 January"
    const yM = d.match(/^(\d{4})\s+([a-zA-Z]+)/);
    if (yM) {
      const mon = months[yM[2].substring(0, 3).toLowerCase()];
      if (mon) return `${mon}/${yM[1]}`;
    }

    // MM/YYYY already
    if (/^\d{2}\/\d{4}$/.test(d)) return d;

    return null;
  }

  /* ═══════════════════ INPUT HELPERS ═══════════════════ */

  /**
   * THE KEY DISCOVERY: Workday uses React with `onInput` (not onChange) handlers
   * exposed on elements via `__reactProps$xxx`. Setting the native value and then
   * calling the React `onInput` handler directly is the ONLY approach that updates
   * both the DOM AND Workday's internal React form state.
   *
   * Approaches that FAILED (DOM updates but React state stays empty):
   * - Native value setter + Event('input')/Event('change') dispatch
   * - document.execCommand('insertText')
   * - _valueTracker hack + InputEvent dispatch
   * - Character-by-character InputEvent dispatch
   *
   * Only two things work:
   * 1. Real browser-level keystrokes (CDP Input.dispatchKeyEvent) — requires chrome.debugger
   * 2. Calling React's onInput handler directly via __reactProps — THIS APPROACH ✓
   */
  function setWorkdayValue(input, value) {
    if (!input || value === undefined || value === null) return false;
    value = String(value);

    // Set native DOM value first (makes the text visible)
    // Wrapped in try-catch: nativeSetter.call can throw "Illegal invocation"
    // if the element is from a different window context (e.g. shadow DOM or iframe).
    try {
      const proto = input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) nativeSetter.call(input, value);
      else input.value = value;
    } catch (e) {
      input.value = value; // Direct assignment as safe fallback
    }

    // ── Strategy 1: React __reactProps$ / __reactEventHandlers$ ────────────
    // Covers React 17+ (__reactProps$) and React 16 (__reactEventHandlers$).
    // Call onInput and onChange directly so Workday's form state updates.
    try {
      const propsKey = Object.keys(input).find(k =>
        k.startsWith('__reactProps') || k.startsWith('__reactEventHandlers')
      );

      if (propsKey) {
        const props = input[propsKey];

        if (props?.onInput) {
          const ev = new InputEvent("input", { bubbles: true, inputType: "insertText", data: value });
          Object.defineProperty(ev, "target", { value: input, writable: false });
          props.onInput(ev);
        }

        if (props?.onChange) {
          const ev = new Event("change", { bubbles: true });
          Object.defineProperty(ev, "target", { value: input, writable: false });
          props.onChange(ev);
        }

        if (props?.onBlur) {
          const ev = new FocusEvent("blur", { bubbles: true });
          Object.defineProperty(ev, "target", { value: input, writable: false });
          props.onBlur(ev);
        }

        LOG(`React props fired for: "${value.substring(0, 25)}"`);
        return true;
      }
    } catch (e) {
      LOG(`React props strategy failed (${e.message}), trying native events`);
    }

    // ── Strategy 1.5: React fiber memoizedProps (uncontrolled components) ──────
    // Uncontrolled Workday textareas use `defaultValue` (no onChange/onInput in
    // __reactProps$). Their __reactFiber$ memoizedProps still carry onBlur which
    // is the validation gate. Calling it directly is the ONLY way to make Workday
    // mark the field as valid without real browser keyboard events.
    try {
      const fiberKey = Object.keys(input).find(k => k.startsWith('__reactFiber'));
      if (fiberKey) {
        const fiber = input[fiberKey];
        const onBlur = fiber?.memoizedProps?.onBlur;
        if (onBlur) {
          onBlur({
            target: input,
            currentTarget: input,
            type: 'blur',
            nativeEvent: new FocusEvent('blur'),
            preventDefault: () => {},
            stopPropagation: () => {},
            persist: () => {}
          });
          LOG(`React fiber onBlur fired for: "${value.substring(0, 25)}"`);
          return true;
        }
      }
    } catch (e) {
      LOG(`React fiber strategy failed (${e.message})`);
    }

    // ── Strategy 2: _valueTracker + native events (non-React / older React) ─
    try {
      const tracker = input._valueTracker;
      if (tracker) tracker.setValue("");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      LOG(`Native events fired for: "${value.substring(0, 25)}"`);
    } catch (e) {
      LOG(`Native events also failed: ${e.message}`);
    }

    return true;
  }

  /** Legacy alias kept for backward compat */
  function setNativeValueFallback(el, value) {
    return setWorkdayValue(el, value);
  }

  /**
   * Strip country code and normalize phone to local format.
   * Workday rejects +1-778-793-7522 — expects 778-793-7522 or (778) 793-7522.
   * Strategy: remove +1, +44, etc. prefix, then reformat digits as XXX-XXX-XXXX.
   */
  function normalizePhone(raw) {
    if (!raw) return "";
    // Remove country code prefix: +1-, +1 , 001-, etc.
    let digits = raw.replace(/^\+1[-\s]?/, "").replace(/^00?1[-\s]?/, "");
    // Strip all non-digit characters
    digits = digits.replace(/\D/g, "");
    // Format as XXX-XXX-XXXX for 10-digit North American numbers
    if (digits.length === 10) {
      return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
    }
    // For other lengths, just return digits (let user fix if Workday rejects)
    return digits || raw;
  }

  /**
   * Return a major city for a given Canadian province/US state.
   * Used when the user profile has no city field.
   */
  function getDefaultCity(province) {
    if (!province) return "";
    const p = province.toLowerCase();
    const map = {
      "british columbia": "Vancouver", "bc": "Vancouver",
      "ontario": "Toronto", "on": "Toronto",
      "alberta": "Calgary", "ab": "Calgary",
      "quebec": "Montreal", "qc": "Montreal",
      "nova scotia": "Halifax", "ns": "Halifax",
      "new brunswick": "Fredericton", "nb": "Fredericton",
      "manitoba": "Winnipeg", "mb": "Winnipeg",
      "saskatchewan": "Saskatoon", "sk": "Saskatoon",
      "newfoundland": "St. John's", "nl": "St. John's",
      "prince edward island": "Charlottetown", "pei": "Charlottetown", "pe": "Charlottetown",
      "northwest territories": "Yellowknife", "nt": "Yellowknife",
      "nunavut": "Iqaluit", "nu": "Iqaluit",
      "yukon": "Whitehorse", "yt": "Whitehorse",
      // US states
      "california": "San Francisco", "ca": "San Francisco",
      "new york": "New York", "ny": "New York",
      "texas": "Austin", "tx": "Austin",
      "washington": "Seattle", "wa": "Seattle",
      "illinois": "Chicago", "il": "Chicago",
      "massachusetts": "Boston", "ma": "Boston",
      "georgia": "Atlanta", "ga": "Atlanta",
    };
    return map[p] || "";
  }

  /**
   * Return a representative postal code for a given city.
   * Used when the user profile has no postalCode field.
   * These are real postal codes for major Canadian/US cities.
   */
  function getDefaultPostalCode(city, province) {
    const c = (city || "").toLowerCase();
    const defaults = {
      "vancouver":    "V6B 1A1",
      "burnaby":      "V5C 6G9",
      "richmond":     "V6Y 2B8",
      "surrey":       "V3T 4W2",
      "victoria":     "V8W 1G4",
      "toronto":      "M5H 2N2",
      "mississauga":  "L5B 1M2",
      "brampton":     "L6T 4G1",
      "ottawa":       "K1A 0A9",
      "calgary":      "T2P 1J9",
      "edmonton":     "T5J 0N3",
      "montreal":     "H3A 1G1",
      "halifax":      "B3J 1R9",
      "winnipeg":     "R3C 0V8",
      "seattle":      "98101",
      "san francisco":"94105",
      "new york":     "10001",
      "austin":       "78701",
      "chicago":      "60601",
      "boston":       "02101",
    };
    for (const [key, postal] of Object.entries(defaults)) {
      if (c.includes(key)) return postal;
    }
    return "";
  }

  function fillFormField(automationId, value) {
    if (!value) return false;
    const field = document.querySelector(`[data-automation-id="${automationId}"]`);
    if (!field) return false;

    const input = field.querySelector('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
    if (!input) return false;
    if (input.value?.trim()) return false; // Already has a value

    const success = setWorkdayValue(input, value);
    if (success) LOG(`Filled ${automationId}: "${value.substring(0, 30)}..."`);
    return success;
  }

  function fillLegacyWorkdayInput(automationId, value) {
    if (!value) return false;
    const el = document.querySelector(`[data-automation-id="${automationId}"]`);
    if (!el) return false;

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.value?.trim()) return false;
      return setWorkdayValue(el, value);
    }

    const input = el.querySelector("input, textarea");
    if (input && !input.value?.trim()) {
      return setWorkdayValue(input, value);
    }
    return false;
  }

  /** Legacy alias for backward compat */
  function setNativeValue(el, value) {
    return setWorkdayValue(el, value) || setNativeValueFallback(el, value);
  }

  /**
   * Select a Workday dropdown option.
   * Workday button-based dropdowns use isTrusted event checks, so programmatic
   * clicks from content scripts may not open them. We try multiple strategies:
   * 1. Click button (works if Workday allows it)
   * 2. Dispatch pointer events sequence
   * 3. Set the hidden input value directly (may not update UI but sets form state)
   * 4. Log failure — user must select manually
   */
  async function selectDropdown(fieldAutomationId, optionText) {
    if (!optionText) return false;

    const field = document.querySelector(`[data-automation-id="${fieldAutomationId}"]`);
    if (!field) {
      LOG(`Dropdown field ${fieldAutomationId} not found`);
      return false;
    }

    // Check if already selected
    const btn = field.querySelector("button");
    if (btn) {
      const currentText = btn.textContent?.trim() || btn.getAttribute("aria-label") || "";
      if (currentText.toLowerCase().includes(optionText.toLowerCase()) &&
          !currentText.toLowerCase().includes("select one")) {
        LOG(`Dropdown ${fieldAutomationId} already has "${optionText}"`);
        return true;
      }
    }

    const dropdownBtn = field.querySelector('button');
    if (!dropdownBtn) return false;

    // Strategy 1: Standard click
    dropdownBtn.click();
    await sleep(500);

    // Check if popup opened
    let opened = await checkAndSelectOption(optionText, fieldAutomationId);
    if (opened) return true;

    // Strategy 2: Pointer events sequence
    const rect = dropdownBtn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    dropdownBtn.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse'
    }));
    dropdownBtn.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse'
    }));
    dropdownBtn.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy
    }));
    await sleep(500);

    opened = await checkAndSelectOption(optionText, fieldAutomationId);
    if (opened) return true;

    // Strategy 3: Use CDP trusted click via background script
    LOG(`Trying CDP trusted click for dropdown ${fieldAutomationId}`);
    document.body.click(); // Close any stale popups
    await sleep(200);

    try {
      const btnSelector = `[data-automation-id="${fieldAutomationId}"] button`;
      // Add a 5s timeout so a non-responsive background script never hangs the flow
      const cdpResult = await Promise.race([
        new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: "CDP_CLICK",
            selector: btnSelector,
            selectOption: optionText,
          }, (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          });
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("CDP_CLICK timeout")), 5000)),
      ]);

      if (cdpResult?.success) {
        // Verify selection
        await sleep(500);
        const verifyBtn = field.querySelector("button");
        const newText = verifyBtn?.textContent?.trim() || "";
        if (!newText.toLowerCase().includes("select one")) {
          LOG(`CDP click succeeded for ${fieldAutomationId}: "${newText}"`);
          return true;
        }
      }

      LOG(`CDP click attempt: ${JSON.stringify(cdpResult)}`);
    } catch (err) {
      LOG(`CDP click error for ${fieldAutomationId}: ${err.message}`);
    }

    LOG(`Dropdown ${fieldAutomationId} could not be filled — user must select "${optionText}" manually`);
    return false;
  }

  /**
   * After opening a dropdown popup, find and click the matching option.
   */
  async function checkAndSelectOption(optionText, fieldAutomationId) {
    const options = document.querySelectorAll(
      '[data-automation-id="promptOption"], [role="option"]'
    );

    // Filter out options that belong to other already-visible listboxes (like phone code)
    for (const opt of options) {
      const text = opt.textContent?.trim() || "";
      if (text.toLowerCase().includes(optionText.toLowerCase())) {
        opt.click();
        LOG(`Selected dropdown option: "${text}" for ${fieldAutomationId}`);
        await sleep(200);
        return true;
      }
    }

    // If we found new options (not just the existing phone code one), the popup opened
    // but didn't have our text
    if (options.length > 1) {
      LOG(`Dropdown opened but no match for "${optionText}" in ${fieldAutomationId}`);
      document.body.click();
      return true; // Return true to stop trying more strategies
    }

    return false;
  }

  /**
   * Handle Workday searchable/hierarchical dropdown fields (like "How Did You Hear About Us?").
   * These can have nested sub-menus (parent → child options).
   * Strategy: open popup → look for matching option or parent category → drill in if needed.
   *
   * @param {string} fieldAutomationId - The formField data-automation-id
   * @param {string[]} searchTexts - Array of text to try, in order of preference
   */
  async function selectSearchableDropdown(fieldAutomationId, ...searchTexts) {
    const field = document.querySelector(`[data-automation-id="${fieldAutomationId}"]`);
    if (!field) {
      LOG(`Searchable field ${fieldAutomationId} not found`);
      return false;
    }

    // Check if already has a selected value (chip with X)
    const existingChip = field.querySelector('[data-automation-id="selectedItem"], [data-automation-id="DELETE_charm"]');
    if (existingChip) {
      LOG(`Searchable field ${fieldAutomationId} already has a selection`);
      return true;
    }

    const input = field.querySelector("input");
    if (!input) {
      LOG(`No input in searchable field ${fieldAutomationId}`);
      return false;
    }

    // Open the popup by clicking the list icon or focusing input
    const listIcon = field.querySelector('[data-automation-id="promptIcon"]');
    if (listIcon) {
      listIcon.click();
    } else {
      input.focus();
      input.click();
    }
    await sleep(500);

    // Get available options
    let options = document.querySelectorAll('[data-automation-id="promptOption"]');

    /**
     * Filter helper — excludes phone country code entries like "Canada (+1)"
     * which appear in global promptOption lists when multiple dropdowns are open.
     */
    const filterOptions = (opts) => Array.from(opts).filter(o => {
      const t = o.textContent?.trim() || "";
      // Reject phone country code options (contain "(+digits)")
      return !t.match(/\(\+\d/);
    });

    // Try each search text in order
    for (const searchText of searchTexts) {
      for (const opt of filterOptions(options)) {
        const text = opt.textContent?.trim() || "";
        if (text.toLowerCase().includes(searchText.toLowerCase())) {
          opt.click();
          LOG(`Selected searchable option: "${text}" for ${fieldAutomationId}`);
          await sleep(500);

          // Check if this opened a sub-menu (options changed)
          const newOptions = filterOptions(document.querySelectorAll('[data-automation-id="promptOption"]'));
          if (newOptions.length > 0 && newOptions[0] !== filterOptions(options)[0]) {
            // Sub-menu opened — look for "Other" or first non-parent option
            for (const subOpt of newOptions) {
              const subText = subOpt.textContent?.trim() || "";
              if (subText.toLowerCase() === "other" || subText.toLowerCase().includes(searchText.toLowerCase())) {
                subOpt.click();
                LOG(`Selected sub-option: "${subText}"`);
                await sleep(200);
                return true;
              }
            }
            // Just click the first sub-option
            if (newOptions.length > 0) {
              newOptions[0].click();
              LOG(`Selected first sub-option: "${newOptions[0].textContent?.trim()}"`);
              await sleep(200);
              return true;
            }
          }

          return true;
        }
      }
    }

    // Fallback: if any filtered options exist, pick the first non-phone one
    const filteredOpts = filterOptions(document.querySelectorAll('[data-automation-id="promptOption"]'));
    if (filteredOpts.length > 0) {
      filteredOpts[0].click();
      LOG(`Selected first available option: "${filteredOpts[0].textContent?.trim()}" for ${fieldAutomationId}`);
      await sleep(200);
      return true;
    }

    // Last resort: type to filter
    setNativeValue(input, searchTexts[0] || "Other");
    await sleep(500);

    const typedOpts = filterOptions(document.querySelectorAll('[data-automation-id="promptOption"]'));
    if (typedOpts.length > 0) {
      typedOpts[0].click();
      LOG(`Selected typed-filter option: "${typedOpts[0].textContent?.trim()}" for ${fieldAutomationId}`);
      await sleep(200);
      return true;
    }

    // Close popup — nothing worked, don't corrupt other fields
    document.body.click();
    LOG(`Could not select option for ${fieldAutomationId}`);
    return false;
  }

  /**
   * Answer a Yes/No question based on label text matching.
   * Workday uses radio buttons or checkboxes for these.
   */
  async function answerYesNoQuestion(labelText, answerYes) {
    const allLabels = document.querySelectorAll("label, span, div");
    for (const label of allLabels) {
      const text = label.textContent?.trim().toLowerCase() || "";
      if (text.length > 200) continue;
      if (!text.includes(labelText.toLowerCase())) continue;

      // Found the question — look for Yes/No radio buttons nearby
      const container = label.closest('[data-automation-id^="formField-"]') ||
                        label.closest("fieldset") ||
                        label.closest("div");
      if (!container) continue;

      const radios = container.querySelectorAll('input[type="radio"]');
      for (const radio of radios) {
        const radioLabel = radio.closest("label")?.textContent?.trim().toLowerCase() ||
                           document.querySelector(`label[for="${radio.id}"]`)?.textContent?.trim().toLowerCase() || "";

        if (answerYes && (radioLabel === "yes" || radioLabel.includes("yes"))) {
          radio.click();
          LOG(`Answered "${labelText}" → Yes`);
          return true;
        }
        if (!answerYes && (radioLabel === "no" || radioLabel.includes("no"))) {
          radio.click();
          LOG(`Answered "${labelText}" → No`);
          return true;
        }
      }
    }
    return false;
  }

  function fillByLabelText(labelTexts, value) {
    if (!value) return false;
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const text = label.textContent?.trim().toLowerCase() || "";
      if (!labelTexts.some(t => text.includes(t))) continue;

      const forId = label.getAttribute("for");
      let input = forId ? document.getElementById(forId) : null;
      if (!input) {
        const container = label.closest("div");
        input = container?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea');
      }

      if (input && !input.value?.trim()) {
        setWorkdayValue(input, value);
        return true;
      }
    }
    return false;
  }

  function getFieldLabel(element) {
    const id = element.id;
    if (id) {
      const ownerDoc = element.ownerDocument || document;
      const label = ownerDoc.querySelector(`label[for="${id}"]`);
      if (label) return label.textContent?.trim() || "";
    }
    const container = element.closest('[data-automation-id^="formField-"]') ||
                      element.closest("div, fieldset, li");
    if (container) {
      const label = container.querySelector("label");
      if (label) return label.textContent?.trim() || "";
    }
    return element.getAttribute("aria-label") || element.placeholder || "";
  }

  /* ═══════════════════ JD SCRAPING ═══════════════════ */

  function scrapeWorkdayJD() {
    const selectors = [
      '[data-automation-id="jobPostingDescription"]',
      '[data-automation-id="job-posting-about"]',
      '[class*="jobDescription"]',
      ".css-cygeeu",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    // Fallback: look for large text blocks with job-related keywords
    const allDivs = document.querySelectorAll("div, section");
    let bestText = "";
    for (const div of allDivs) {
      const text = div.innerText?.trim() || "";
      if (text.length > 300 && text.length < 10000 &&
        (text.includes("Responsibilities") || text.includes("Qualifications") ||
          text.includes("Requirements") || text.includes("About")) &&
        text.length > bestText.length) {
        bestText = text;
      }
    }
    return bestText;
  }

  /* ═══════════════════ SUBMIT WATCHER ═══════════════════ */

  function watchForSubmit(job) {
    const observer = new MutationObserver(() => {
      const pageText = document.body.innerText || "";

      if (pageText.includes("Application Submitted") ||
          pageText.includes("Thank you for applying") ||
          pageText.includes("Your application has been submitted") ||
          pageText.includes("Successfully Submitted")) {
        LOG("Detected application submitted confirmation!");
        observer.disconnect();
        showBanner("Application submitted successfully! Moving to next job...", "success");

        // Record the application submission
        chrome.runtime.sendMessage({
          type: "RECORD_APPLICATION",
          data: {
            jobTitle: job.jobTitle,
            company: job.company,
            location: job.location,
            ats: "workday",
            jobUrl: job.jobUrl || window.location.href,
            jobDescription: job.jobDescription || "",
            resumeFilename: job.resumeFilename || "resume.pdf",
          },
        }).catch(err => LOG("Failed to record application:", err.message));
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 600000); // Stop after 10 min
  }

  /* ═══════════════════ UTILITIES ═══════════════════ */

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  function sendMessageWithTimeout(msg, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for API response")), timeout);
      chrome.runtime.sendMessage(msg, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  /* ═══════════════════ UI BANNER ═══════════════════ */

  // Module-level timer state — avoids closure-capture race when showBanner is
  // called multiple times before the first async chrome.storage callback fires.
  // Previously timerStart was captured per-call inside the async closure, causing
  // multiple intervals to run when rapid showBanner calls overlapped.
  let aaTimerStart = null;
  let aaTimerIntervalId = null;
  let aaPdfPollIntervalId = null; // polls for tailoredResumePdf until it arrives

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

    // ── Timer management (Issue #4 fix) ──
    // Clear synchronously BEFORE entering the async callback so that rapid
    // back-to-back showBanner calls cannot leave orphaned intervals running.
    if (aaTimerIntervalId)    { clearInterval(aaTimerIntervalId);    aaTimerIntervalId    = null; }
    if (banner._dismissTimer) { clearTimeout(banner._dismissTimer);  banner._dismissTimer = null; }
    // Stop any in-flight PDF-poll from the previous banner state.
    if (aaPdfPollIntervalId)  { clearInterval(aaPdfPollIntervalId);  aaPdfPollIntervalId  = null; }

    const isAi = (type === "ai" || type === "info");
    if (isAi) {
      if (!aaTimerStart) aaTimerStart = Date.now(); // preserve across consecutive ai calls
    } else {
      aaTimerStart = null; // reset when handing off to user / done / error
    }
    // Capture synchronously — NOT inside the async callback — so every call
    // that runs concurrently shares the same stable value.
    const timerStart = aaTimerStart;

    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 16px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.1);
      transition: background 0.35s ease, opacity 0.2s ease;
    `;

    const typeConfig = {
      ai:      { bg: "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)", icon: "✦", actor: "AutoApply" },
      info:    { bg: "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)", icon: "✦", actor: "AutoApply" },
      user:    { bg: "linear-gradient(135deg, #92400E 0%, #B45309 100%)", icon: "→", actor: "Your turn" },
      success: { bg: "linear-gradient(135deg, #065F46 0%, #047857 100%)", icon: "✓", actor: "Done" },
      error:   { bg: "linear-gradient(135deg, #991B1B 0%, #B91C1C 100%)", icon: "!", actor: "Attention" },
    };
    const cfg = typeConfig[type] || typeConfig.ai;

    chrome.storage.local.get(["_aa_batchProgress", "tailoredResumePdf", "tailoredResumeMap", "pendingApplication", "lastTailoredJob"], (result) => {
      const bp = result._aa_batchProgress;
      const hasBatch = bp && bp.total > 0;
      const hasPdf = !!result.tailoredResumePdf || !!(Object.keys(result.tailoredResumeMap || {}).length > 0);

      // ── Row 1: Batch counter + job title/company/salary pills
      const batchTag = hasBatch
        ? `<span style="background:rgba(255,255,255,0.18);border-radius:6px;padding:2px 10px;font-size:13px;font-weight:700;white-space:nowrap;">Job ${bp.current} / ${bp.total}</span>`
        : "";
      const pillStyle = `font-size:12px;opacity:0.9;background:rgba(255,255,255,0.15);border-radius:5px;padding:2px 8px;white-space:nowrap;`;
      const companyTag = (hasBatch && bp.company)
        ? `<span style="${pillStyle}">${bp.company}</span>` : "";
      const roleTag = (hasBatch && bp.title)
        ? `<span style="${pillStyle}">${bp.title}</span>` : "";
      const salaryTag = (hasBatch && bp.salaryRange)
        ? `<span style="${pillStyle}">${bp.salaryRange}</span>` : "";

      // ── Row 2: Progress bar (only when batch active)
      const pct = hasBatch ? Math.round(((bp.current - 1) / bp.total) * 100) : 0;
      const progressBar = hasBatch ? `
        <div style="height:3px;background:rgba(255,255,255,0.2);margin:6px 0 4px;">
          <div style="height:100%;width:${pct}%;background:rgba(255,255,255,0.7);border-radius:2px;transition:width 0.4s;"></div>
        </div>` : "";

      // ── Row 3: Actor badge + status message + live timer (ai only)
      const actorBadge = `<span style="font-size:11px;font-weight:600;background:rgba(255,255,255,0.18);border-radius:5px;padding:2px 8px;letter-spacing:0.2px;white-space:nowrap;">${cfg.icon} ${cfg.actor}</span>`;
      const statusMsg  = `<span style="font-size:13px;font-weight:500;">${message}</span>`;
      const timerEl    = isAi
        ? `<span id="aa-elapsed-timer" style="font-size:14px;font-weight:700;opacity:0.9;margin-left:auto;font-variant-numeric:tabular-nums;letter-spacing:1px;background:rgba(0,0,0,0.18);border-radius:5px;padding:1px 8px;">0:00</span>`
        : "";

      // ── Optional subtext row
      const subtextRow = opts.subtext
        ? `<div style="font-size:11px;opacity:0.75;margin-top:3px;padding-left:2px;">${opts.subtext}</div>`
        : "";

      // Resume download button — always shown when PDF is ready
      const pdfBtnStyle = `border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;background:#fff;color:#4F46E5;`;
      const pdfBtn = hasPdf
        ? `<button id="aa-btn-download-resume" style="${pdfBtnStyle}">↓ Resume</button>`
        : "";

      // (Issue #3 fix) — if PDF isn't ready yet, start polling so the button
      // appears as soon as tailoring finishes (without requiring a new showBanner call).
      // We only poll when the current banner type warrants a PDF button at all.
      const shouldPollForPdf = !hasPdf && (isAi || type === "user");
      if (shouldPollForPdf) {
        let pdfPollAttempts = 0;
        aaPdfPollIntervalId = setInterval(() => {
          pdfPollAttempts++;
          if (pdfPollAttempts > 45) { clearInterval(aaPdfPollIntervalId); aaPdfPollIntervalId = null; return; } // ~90s max
          chrome.storage.local.get(["tailoredResumePdf"], (rPdf) => {
            if (!rPdf.tailoredResumePdf) return;
            clearInterval(aaPdfPollIntervalId); aaPdfPollIntervalId = null;
            if (document.getElementById("aa-btn-download-resume")) return; // already present
            const actionDivs = document.querySelectorAll("#autoapply-banner div[style*='display:flex']");
            const actionDiv = actionDivs[actionDivs.length - 1]; // last flex row = action buttons
            if (!actionDiv) return;
            const newBtn = document.createElement("button");
            newBtn.id = "aa-btn-download-resume";
            newBtn.style.cssText = pdfBtnStyle;
            newBtn.textContent = "↓ Resume";
            actionDiv.appendChild(newBtn);
            newBtn.addEventListener("click", () => {
              _downloadResumeForPage();
              newBtn.textContent = "↓ Download again"; newBtn.disabled = false;
              });
            });
          });
        }, 2000);
      }

      // ── Action buttons
      const btnStyle = `border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;`;
      const pauseBtn = isAi
        ? `<button id="aa-btn-pause" style="${btnStyle}background:rgba(255,255,255,0.18);color:#fff;margin-left:auto;">Pause</button>`
        : "";
      const resumeBtn = opts.showResume
        ? `<button id="aa-btn-resume" style="${btnStyle}background:rgba(255,255,255,0.3);color:#fff;">Resume</button>`
        : "";

      let actionRow = "";
      if (type === "error") {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">Try again</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.4);">Reload resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">Skip</button>
          ${pdfBtn}
        </div>`;
      } else if (type === "user") {
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          ${resumeBtn}
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">Fill again</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.4);">Reload resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.15);color:rgba(255,255,255,0.85);">Skip</button>
          ${pdfBtn}
        </div>`;
      } else if (isAi) {
        // AI state: show pause button + PDF download if available
        const innerBtns = [pdfBtn, pauseBtn].filter(Boolean).join("");
        actionRow = innerBtns ? `<div style="margin-top:6px;display:flex;gap:6px;align-items:center;">${innerBtns}</div>` : "";
      } else {
        // Fallback: ensure Retry button is always present for consistency (Issue #19/#21)
        actionRow = `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">Try again</button>
        </div>`;
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

      // Wire up action buttons
      document.getElementById("aa-btn-retry")?.addEventListener("click", () => {
        LOG("Retry clicked — re-running state machine");
        removeBanner();
        window.__autoapply_ats_injected = false; // clear guard so init can re-run
        startStateMachine();
      });
      document.getElementById("aa-btn-reload-resume")?.addEventListener("click", async () => {
        LOG("Reload Resume clicked — clearing cache and re-tailoring");
        removeBanner();
        // Clear all cached tailoring data so startStateMachine triggers a fresh TAILOR_AND_FILL
        await new Promise(resolve => chrome.storage.local.remove([
          "tailoredResumePdf",
          "tailoredResumeFilename",
          "lastTailoredResult",
          "lastTailoredJob"
        ], resolve));
        window.__autoapply_ats_injected = false;
        startStateMachine();
      });
      document.getElementById("aa-btn-skip")?.addEventListener("click", () => {
        LOG("Skip clicked — clearing pending application");
        chrome.storage.local.remove(["pendingApplication"]);
        showBanner("Job skipped — you can close this tab.", "success");
      });
      document.getElementById("aa-btn-download-resume")?.addEventListener("click", () => {
        _downloadResumeForPage();
        const btn = document.getElementById("aa-btn-download-resume");
        if (btn) { btn.textContent = "↓ Download again"; btn.disabled = false; }
      });
      document.getElementById("aa-btn-pause")?.addEventListener("click", () => {
        LOG("Paused by user");
        chrome.storage.local.set({ _aa_paused: true });
        showBanner("Paused — click Resume when ready.", "user", {
          subtext: "AutoApply will continue from where it left off.",
          showResume: true,
        });
      });
      document.getElementById("aa-btn-resume")?.addEventListener("click", () => {
        LOG("Resumed by user");
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

      // Start ticking after DOM is updated (Issue #4 fix: assign to module-level
      // aaTimerIntervalId so rapid re-calls can clearInterval synchronously before
      // their own async callback fires — no orphaned intervals).
      if (isAi && timerStart) {
        aaTimerIntervalId = setInterval(() => {
          const el = document.getElementById("aa-elapsed-timer");
          if (!el) return;
          const elapsed = Math.floor((Date.now() - aaTimerStart) / 1000);
          const m = Math.floor(elapsed / 60);
          const s = elapsed % 60;
          el.textContent = `${m}:${s.toString().padStart(2, "0")}`;
        }, 1000);
      }
    });

    if (type === "success") banner._dismissTimer = setTimeout(() => removeBanner(), 15000);
    if (type === "error")   banner._dismissTimer = setTimeout(() => removeBanner(), 20000);
  }

  /** Remove the banner and restore body padding. */
  function removeBanner() {
    const b = document.getElementById("autoapply-banner");
    if (!b) return;

    // Check if tailored PDF exists — if so, preserve the download button as a standalone element
    chrome.storage.local.get(["tailoredResumeMap", "tailoredResumePdf", "pendingApplication", "lastTailoredJob"], (result) => {
      const hasAnyPdf = !!(result.tailoredResumePdf) || !!(Object.keys(result.tailoredResumeMap || {}).length > 0);
      if (hasAnyPdf) {
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
            _downloadResumeForPage();
            clonedBtn.textContent = "↓ Download again";
            clonedBtn.disabled = false;
          });
        }
      }
    });

    // Clean up module-level timer/poll state
    if (aaTimerIntervalId)   { clearInterval(aaTimerIntervalId);   aaTimerIntervalId   = null; }
    if (aaPdfPollIntervalId) { clearInterval(aaPdfPollIntervalId); aaPdfPollIntervalId = null; }
    aaTimerStart = null;

    // Remove banner and restore padding
    b.remove();
    document.body.style.paddingTop = "";
  }

  /**
   * Inject the "↓ Resume" download button into the live banner immediately
   * when tailoredResumePdf becomes available — without waiting for the next
   * showBanner call. Idempotent: does nothing if button is already present.
   * Subsequent showBanner calls will include it naturally via the hasPdf check.
   */
  function injectOrRefreshDownloadButton() {
    if (document.getElementById("aa-btn-download-resume")) return;
    const banner = document.getElementById("autoapply-banner");
    if (!banner) return;
    chrome.storage.local.get(["tailoredResumePdf", "tailoredResumeMap"], (result) => {
      const hasAnyPdf = !!(result.tailoredResumePdf) || !!(Object.keys(result.tailoredResumeMap || {}).length > 0);
      if (!hasAnyPdf) return;
      if (document.getElementById("aa-btn-download-resume")) return; // re-check after async gap
      const wrapper = banner.querySelector("div");
      if (!wrapper) return;
      const btn = document.createElement("button");
      btn.id = "aa-btn-download-resume";
      btn.style.cssText = "border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;background:#fff;color:#4F46E5;margin-top:6px;";
      btn.textContent = "↓ Resume";
      btn.addEventListener("click", () => {
        _downloadResumeForPage();
        btn.textContent = "↓ Download again";
        btn.disabled = false;
      });
      wrapper.appendChild(btn);
      LOG("Persistent download button injected into banner");
    });
  }

  // Proactively show the download button the moment tailoredResumePdf is ready —
  // survives across showBanner calls since showBanner re-checks storage each time.
  // Fires when either the legacy global key or the new keyed map is written.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.tailoredResumePdf?.newValue && !changes.tailoredResumeMap?.newValue) return;
    LOG("Resume data ready — injecting persistent download button");
    injectOrRefreshDownloadButton();
  });

  /**
   * Pause-aware delay: waits until _aa_paused is false before returning.
   * Called before advancing steps so the user can pause mid-application.
   */
  async function waitForResume() {
    while (true) {
      const paused = await new Promise(resolve =>
        chrome.storage.local.get(["_aa_paused"], r => resolve(r._aa_paused))
      );
      if (!paused) return;
      await sleep(600);
    }
  }
})();
