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
  LOG("Script loaded on", window.location.href);

  // Start after a delay to let Workday render
  setTimeout(() => startStateMachine(), 2000);

  /* ═══════════════════ STATE MACHINE ═══════════════════ */

  async function startStateMachine() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      LOG("No pending application found — watching for Apply button if user navigates");
      return;
    }

    const pendingJob = stored.pendingApplication;
    LOG("Processing application for", pendingJob.jobTitle);
    showBanner("Preparing Workday application...", "ai");

    try {
      const page = detectPage();
      LOG("Detected page type:", page);

      if (page === "jobPosting") {
        // We're on the job posting page — need to navigate to form
        showBanner("Navigating to application form...", "ai");
        await navigateToForm();
        // After navigation, Workday will reload as SPA — this script instance continues
        // Wait for the form to render
        await waitForElement('[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="applyFlowPage"]', 15000);
        await sleep(2000); // Extra wait for fields to render
      } else if (page === "modal") {
        // Modal is already open
        await handleApplyModal();
        await waitForElement('[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="applyFlowPage"]', 15000);
        await sleep(2000);
      }
      // else: already on form page

      // Now we should be on the form — determine which step
      await processCurrentStep(pendingJob);

    } catch (err) {
      LOG("Error:", err);
      showBanner(`Error — please apply manually.`, "error", { subtext: err.message });
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
    // Step 1: Click the Apply button
    const applyBtn = document.querySelector('[data-automation-id="adventureButton"]');
    if (!applyBtn) {
      LOG("No Apply button found — checking if already on form");
      return;
    }

    LOG("Clicking Apply button");
    applyBtn.click();
    await sleep(2000);

    // Step 2: Handle the Apply modal
    await handleApplyModal();
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
    const step = getCurrentStep();
    LOG("Current step:", step);

    // Scrape JD if available (might still be in DOM from job posting)
    const pageJD = scrapeWorkdayJD();
    const jobDescription = pageJD || pendingJob.jobDescription;

    // Request AI tailoring
    showBanner("Tailoring your resume for this role...", "ai");
    let tailoredData = null;

    try {
      tailoredData = await sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 90000);

      if (tailoredData?.error) {
        LOG("Tailoring error:", tailoredData.error);
        showBanner("Tailoring had an issue — filling with base resume data.", "error", { subtext: tailoredData.error });
      }
    } catch (err) {
      LOG("Tailoring request failed:", err.message);
      showBanner("Tailoring timed out — filling with base resume data.", "error");
    }

    // Fill the current step
    showBanner("Filling application form...", "ai");

    if (step === 1) {
      await fillStep1(tailoredData?.tailoredResult, pendingJob);
      await advanceToStep(2);
      // Step 2 = resume upload — download the tailored PDF and wait for user to upload
      await handleStep2ResumeUpload(tailoredData, pendingJob);

    } else if (step === 2) {
      // Landed directly on Step 2 — same resume upload flow
      await handleStep2ResumeUpload(tailoredData, pendingJob);

    } else if (step === 3) {
      await fillStep3(tailoredData?.tailoredResult, pendingJob);
      await advanceToStep(4);
      showBanner("Review your application and click Submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
      watchForSubmit(pendingJob);

    } else if (step === 4) {
      LOG("On Review step — user should review and submit");
      showBanner("Review your application and click Submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
      watchForSubmit(pendingJob);
    }
  }

  /**
   * Handle Step 2 (My Experience / Resume Upload).
   * Downloads the tailored PDF, shows a persistent "waiting" banner,
   * watches for the user to upload the file, then continues automatically.
   */
  async function handleStep2ResumeUpload(tailoredData, pendingJob) {
    // First try programmatic upload — if Workday allows it, great
    const uploaded = await uploadResumeProgrammatically();

    if (uploaded) {
      // Programmatic upload succeeded — proceed automatically
      await sleep(1500);
      showBanner("Resume uploaded! Continuing application...", "ai");
      await fillStep2(tailoredData?.tailoredResult, pendingJob);
      await advanceToStep(3);
      await sleep(1000);
      await fillStep3(tailoredData?.tailoredResult, pendingJob);
      await advanceToStep(4);
      showBanner("Review your application and click Submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
      watchForSubmit(pendingJob);
      chrome.storage.local.remove(["pendingApplication"]);
      return;
    }

    // Programmatic upload failed — download PDF and wait for manual upload
    chrome.runtime.sendMessage({
      type: "DOWNLOAD_RESUME",
      job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
    });

    showBanner(
      "Upload the downloaded resume PDF — AutoApply will continue automatically once detected.",
      "user",
      { subtext: "Check your Downloads folder for the tailored PDF." }
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
    showBanner("Resume detected! Taking over and finishing the application...", "ai");
    LOG("Resume upload detected — advancing through remaining steps");

    await sleep(1500); // Let Workday process the upload

    await fillStep2(tailoredData?.tailoredResult, pendingJob);
    await advanceToStep(3);
    await sleep(1000);
    await fillStep3(tailoredData?.tailoredResult, pendingJob);
    await advanceToStep(4);

    showBanner("Review your application and click Submit when ready.", "user", { subtext: "AutoApply stops here — you stay in control of the final submit." });
    watchForSubmit(pendingJob);
    chrome.storage.local.remove(["pendingApplication"]);
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
   * Auto-advance to the next step by clicking the Next button.
   * Checks for validation errors before and after clicking.
   */
  async function advanceToStep(nextStep) {
    LOG(`Advancing to Step ${nextStep}...`);

    // Check for pre-existing validation errors on the page
    const errorsBefore = document.querySelectorAll(
      '[data-automation-id="validationError"], .wd-error, [class*="error"]:not([class*="icon"])'
    );
    if (errorsBefore.length > 0) {
      const errorTexts = Array.from(errorsBefore).map(e => e.textContent?.trim()).filter(Boolean).slice(0, 3);
      LOG(`WARNING: ${errorsBefore.length} validation errors on page before clicking Next:`, errorTexts.join(", "));
      showBanner(`Form has validation errors — please fix the highlighted fields.`, "user", { subtext: errorTexts.join(" · ") });
      return; // Don't click Next if there are errors
    }

    // Find and click the Next button
    const nextBtn = document.querySelector('[data-automation-id="pageFooterNextButton"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Next');

    if (nextBtn) {
      nextBtn.click();
      LOG(`Clicked Next button`);
    } else {
      LOG(`No Next button found to advance to Step ${nextStep}`);
      return;
    }

    // Wait briefly then check for validation errors that appeared after clicking Next
    await sleep(1000);
    const errorsAfter = document.querySelectorAll(
      '[data-automation-id="validationError"], [class*="ValidationError"]'
    );
    if (errorsAfter.length > 0) {
      const errorTexts = Array.from(errorsAfter).map(e => e.textContent?.trim()).filter(Boolean).slice(0, 3);
      LOG(`Validation errors appeared after Next click:`, errorTexts.join(", "));
      showBanner(`Some required fields need attention — check highlighted fields.`, "user", { subtext: errorTexts.join(" · ") });
      return;
    }

    // Wait for the next step to render
    const progressBar = await waitForElement('[data-automation-id="progressBarActiveStep"]', 8000);
    if (progressBar) {
      for (let i = 0; i < 20; i++) {
        const stepText = progressBar.textContent?.trim() || "";
        if (stepText.includes(String(nextStep)) || stepText.includes(`Step ${nextStep}`)) {
          LOG(`Successfully advanced to Step ${nextStep}`);
          await sleep(500);
          return;
        }
        await sleep(100);
      }
    }

    await sleep(1000);
    LOG(`Advanced (verification uncertain)`);
  }

  function getCurrentStep() {
    // Try step indicator first
    const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    if (activeStep) {
      const text = activeStep.textContent || "";
      const match = text.match(/step\s*(\d+)/i);
      if (match) return parseInt(match[1]);
    }

    // Fallback: detect by page content
    const pageText = document.body.innerText || "";
    const url = window.location.href.toLowerCase();

    if (url.includes("myinformation") || url.includes("applymanually") ||
        pageText.includes("My Information") && pageText.includes("Legal Name")) {
      return 1;
    }
    if (pageText.includes("My Experience") && (pageText.includes("Resume") || pageText.includes("Work Experience"))) {
      return 2;
    }
    if (pageText.includes("Application Questions")) {
      return 3;
    }
    if (pageText.includes("Review") && pageText.includes("Submit")) {
      return 4;
    }

    return 1; // Default to step 1
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
    const address = user.address || resume.contactInfo?.address || "";
    const province = user.province || resume.contactInfo?.province || "";
    // Use stored city, or fall back to a major city for the province
    const city = user.city || resume.contactInfo?.city || getDefaultCity(province);
    const postalCode = user.postalCode || resume.contactInfo?.postalCode || "";

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

    // PARALLEL DROPDOWN FILLING: Fill all dropdowns in parallel
    LOG("Filling dropdowns in parallel...");

    const dropdownPromises = [];

    // "How Did You Hear About Us?" — formField-source (hierarchical searchable)
    dropdownPromises.push(selectSearchableDropdown("formField-source", "Job Sites", "LinkedIn", "Career Websites", "Other"));

    // Province/Territory
    if (province) {
      dropdownPromises.push(selectDropdown("formField-countryRegion", province));
    }

    // Phone Device Type — default to Mobile
    dropdownPromises.push(selectDropdown("formField-phoneType", "Mobile"));

    // Wait for all dropdowns to complete
    await Promise.all(dropdownPromises);

    LOG("Step 1 filled");
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
    LOG("Step 2 — My Experience (resume upload step)");

    await sleep(500);

    // Try to upload resume programmatically
    await uploadResumeProgrammatically();

    // Look for any text inputs on this step
    const profile = await chrome.storage.local.get(["userProfile", "parsedResume"]);
    const user = profile.userProfile || {};
    const resume = profile.parsedResume || {};

    // Batch text field filling for Step 2
    const step2Fields = [
      { id: "formField-jobTitle", value: resume.workExperience?.[0]?.title || "" },
      { id: "formField-company", value: resume.workExperience?.[0]?.company || "" },
    ];

    for (const fieldDef of step2Fields) {
      fillFormField(fieldDef.id, fieldDef.value);
    }

    await sleep(200);

    // LinkedIn URL field (sometimes on Step 2)
    const linkedinField = document.querySelector('[data-automation-id*="linkedin" i]') ||
                          document.querySelector('[data-automation-id*="LinkedIn"]');
    if (linkedinField) {
      const input = linkedinField.querySelector("input");
      if (input && !input.value && user.linkedin) {
        setWorkdayValue(input, user.linkedin);
      }
    }

    // Try filling website/portfolio field
    if (user.website || user.portfolio) {
      fillByLabelText(["website", "portfolio", "personal site"], user.website || user.portfolio);
    }

    LOG("Step 2 filled");
  }

  /**
   * Upload resume programmatically on Step 2.
   * Gets base64 PDF from chrome.storage.local key 'tailoredResumePdf',
   * decodes it, and injects it into the file input using Object.defineProperty.
   */
  async function uploadResumeProgrammatically() {
    try {
      const stored = await chrome.storage.local.get(["tailoredResumePdf"]);
      const base64Pdf = stored.tailoredResumePdf;

      if (!base64Pdf) {
        LOG("No tailored resume PDF found in storage");
        return false;
      }

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

    if (!tailoredResult) {
      LOG("No tailored result — skipping application questions");
      return;
    }

    // Fill textareas (cover letter, why interested, etc.)
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
      }
    }

    await sleep(200);

    // PARALLEL YES/NO QUESTION ANSWERING
    const yesNoPromises = [
      answerYesNoQuestion("authorized to work", true),
      answerYesNoQuestion("legally authorized", true),
      answerYesNoQuestion("require sponsorship", false),
      answerYesNoQuestion("willing to relocate", true),
    ];

    await Promise.all(yesNoPromises);

    // Handle dropdown questions
    const formFields = document.querySelectorAll('[data-automation-id^="formField-"]');
    for (const field of formFields) {
      const label = field.querySelector("label")?.textContent?.toLowerCase() || "";
      const btn = field.querySelector("button[aria-haspopup]");

      if (btn && !btn.textContent?.includes("Select")) continue; // Already has a selection

      // Common dropdown questions
      if (label.includes("years of experience") || label.includes("experience level")) {
        await selectDropdown(field.getAttribute("data-automation-id"), "5");
      }
    }

    LOG("Step 3 filled");
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

    // Find React props key on the element
    const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps'));
    if (!propsKey) {
      LOG(`No React props found on element — falling back to native setter`);
      return setNativeValueFallback(input, value);
    }

    const props = input[propsKey];
    const onInput = props?.onInput;
    const onBlur = props?.onBlur;

    if (!onInput) {
      LOG(`No onInput handler in React props — falling back to native setter`);
      return setNativeValueFallback(input, value);
    }

    // Set value via native setter (bypasses React's controlled input checks)
    const proto = input.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }

    // Call React's onInput handler directly — this updates Workday's form state
    const inputEvent = new Event("input", { bubbles: true });
    Object.defineProperty(inputEvent, "target", { value: input, writable: false });
    onInput(inputEvent);

    // Trigger blur to finalize validation
    if (onBlur) {
      const blurEvent = new Event("blur", { bubbles: true });
      Object.defineProperty(blurEvent, "target", { value: input, writable: false });
      onBlur(blurEvent);
    }

    return true;
  }

  /** Fallback for elements without React props (older Workday instances) */
  function setNativeValueFallback(el, value) {
    if (!el || !value) return false;
    el.focus();

    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;

    // Try _valueTracker reset for standard React apps
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue("");

    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
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
      const cdpResult = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "CDP_CLICK",
          selector: btnSelector,
          selectOption: optionText,
        }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });

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

    // Try each search text in order
    for (const searchText of searchTexts) {
      for (const opt of options) {
        const text = opt.textContent?.trim() || "";
        if (text.toLowerCase().includes(searchText.toLowerCase())) {
          opt.click();
          LOG(`Selected searchable option: "${text}" for ${fieldAutomationId}`);
          await sleep(500);

          // Check if this opened a sub-menu (options changed)
          const newOptions = document.querySelectorAll('[data-automation-id="promptOption"]');
          if (newOptions.length > 0 && newOptions[0] !== options[0]) {
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

    // Fallback: try typing to filter
    setNativeValue(input, searchTexts[0] || "Other");
    await sleep(500);

    options = document.querySelectorAll('[data-automation-id="promptOption"]');
    if (options.length > 0) {
      options[0].click();
      LOG(`Selected filtered option: "${options[0].textContent?.trim()}" for ${fieldAutomationId}`);
      await sleep(200);
      return true;
    }

    // Close popup
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
      const label = document.querySelector(`label[for="${id}"]`);
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
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    `;

    // Colour + actor config per type
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

      // ── Row 1: Batch counter + job title/company
      const batchTag = hasBatch
        ? `<span style="background:rgba(255,255,255,0.18);border-radius:6px;padding:2px 10px;font-size:13px;font-weight:700;white-space:nowrap;">Job ${bp.current} / ${bp.total}</span>`
        : "";
      const jobLabel = hasBatch && bp.title
        ? `<span style="font-size:12px;opacity:0.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${bp.title}${bp.company ? " · " + bp.company : ""}</span>`
        : "";

      // ── Row 2: Progress bar (only when batch active)
      const pct = hasBatch ? Math.round(((bp.current - 1) / bp.total) * 100) : 0;
      const progressBar = hasBatch ? `
        <div style="height:3px;background:rgba(255,255,255,0.2);margin:6px 0 4px;">
          <div style="height:100%;width:${pct}%;background:rgba(255,255,255,0.7);border-radius:2px;transition:width 0.4s;"></div>
        </div>` : "";

      // ── Row 3: Actor icon + status message
      const actorBadge = `<span style="font-size:11px;font-weight:700;background:rgba(255,255,255,0.2);border-radius:4px;padding:1px 7px;letter-spacing:0.3px;">${cfg.icon} ${cfg.actor.toUpperCase()}</span>`;
      const statusMsg = `<span style="font-size:13px;font-weight:500;">${message}</span>`;

      // ── Optional subtext row
      const subtextRow = opts.subtext
        ? `<div style="font-size:11px;opacity:0.75;margin-top:3px;padding-left:2px;">${opts.subtext}</div>`
        : "";

      banner.style.background = cfg.bg;
      banner.style.color = "#fff";
      banner.innerHTML = `
        <div style="padding:8px 18px 7px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${batchTag}${jobLabel}</div>
          ${progressBar}
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">${actorBadge}${statusMsg}</div>
          ${subtextRow}
        </div>`;
    });

    // Clear any existing auto-dismiss timer
    if (banner._dismissTimer) clearTimeout(banner._dismissTimer);
    if (type === "success") banner._dismissTimer = setTimeout(() => banner.remove(), 15000);
    if (type === "error")   banner._dismissTimer = setTimeout(() => banner.remove(), 20000);
    // "user" and "ai" types stay until explicitly replaced
  }
})();
