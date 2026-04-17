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
  const LOG = (msg, ...args) => console.log(`AutoApply GH: ${msg}`, ...args);

  /**
   * Download the tailored resume for the CURRENT page.
   * Uses window.location.href as the primary key — the resume was always
   * tailored on this exact page, so its URL is guaranteed to match the stored key.
   * Falls back to pendingApplication / lastTailoredJob for edge cases.
   */
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

      // Priority 1: exact page URL key match (jobs applied to directly on Greenhouse)
      const pageKey = _mk({ applyUrl: window.location.href });
      if (map[pageKey]) {
        LOG("Downloading by exact page key:", pageKey);
        chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: { applyUrl: window.location.href } });
        return;
      }

      // Priority 2: scan map entries for a company name match against the current page.
      // Handles the common case where the job was queued from LinkedIn (so the map key is
      // a LinkedIn URL), but we're now on the Greenhouse ATS page.
      // Each entry has { company, jobTitle, jobUrl } — jobUrl is the original applyUrl.
      const urlLower   = window.location.href.toLowerCase();
      const titleLower = (document.title || "").toLowerCase();
      const matched = Object.values(map).find(entry => {
        if (!entry.company) return false;
        const co = entry.company.toLowerCase().replace(/\s+/g, "");
        return urlLower.includes(co) || titleLower.includes(co);
      });
      if (matched) {
        LOG("Found resume by company match:", matched.company, "filename:", matched.filename);
        // Send the stored jobUrl so handleDownloadResume can look up the correct keyed entry
        chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: { applyUrl: matched.jobUrl || window.location.href } });
        return;
      }

      // [Fix 2026-04-13] Removed global `tailoredResumePdf` fallback to
      // prevent cross-contamination where Job A's resume gets uploaded onto
      // Job B's form if Job B was opened before its own tailoring completed.
      // Now: request download with noGlobalFallback; background will emit
      // SHOW_BANNER telling the user to "Tailor Resume first".
      LOG("No keyed or company match — requesting download without fallback (will show banner)");
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { applyUrl: window.location.href },
        noGlobalFallback: true,
      });
    });
  }

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
      await fillAllFields(user, null, null, null);
      await attemptResumeUpload();
      console.log("AutoApply: GH child frame filled form");
    })();
    return; // don't run main init() flow
  }

  // NOTE: showBanner is NOT called here — it's called inside init() after pendingApplication
  // is confirmed. Calling it unconditionally here caused a misleading banner on all Greenhouse
  // pages even when no AutoApply flow was active.
  setTimeout(() => init(), 1500);

  async function init() {
    // ── Funnel Stage 4: Confirmation page detection ──────────────────────────
    // Greenhouse redirects to a new page on submit — MutationObserver can't catch
    // that. Instead, at init() time we check if this IS a confirmation page.
    // If so, look up the lastFilledJob and record stage 4 (completed).
    const pageTextEarly = (document.body?.innerText || "").toLowerCase();
    const pageHtmlEarly = (document.body?.innerHTML || "").toLowerCase();
    const isConfirmationPage =
      pageTextEarly.includes("application sent") ||
      pageTextEarly.includes("application submitted") ||
      pageTextEarly.includes("thank you for applying") ||
      pageTextEarly.includes("your application has been received") ||
      pageTextEarly.includes("thank you for your interest") ||
      pageTextEarly.includes("successfully submitted") ||
      pageHtmlEarly.includes("submit-success") ||
      pageHtmlEarly.includes("application-success");

    if (isConfirmationPage) {
      const lastData = await new Promise(r => chrome.storage.local.get(["lastFilledJob"], r));
      const lastJob = lastData.lastFilledJob;
      if (lastJob && !lastJob._completionRecorded) {
        console.log("AutoApply: Detected Greenhouse confirmation page — recording Stage 4 (completed)");
        // Mark as recorded so re-injection doesn't double-count
        chrome.storage.local.set({ lastFilledJob: { ...lastJob, _completionRecorded: true } });
        chrome.runtime.sendMessage({
          type: "FUNNEL_STAGE",
          stage: "completed",
          job: {
            id: lastJob.id,
            jobTitle: lastJob.jobTitle,
            company: lastJob.company,
            jobUrl: lastJob.jobUrl || window.location.href,
            matchScore: lastJob.matchScore || 0,
            completedAt: new Date().toISOString(),
          },
        }).catch(() => {});
        // Update banner to show success
        showBanner("Application submitted — logged to your dashboard.", "success");
      }
      return; // Don't try to fill a confirmation page
    }

    const stored = await chrome.storage.local.get(["pendingApplication", "_aa_scrapeAndTailor"]);

    // ── Self-scrape path: triggered by "Fill this form" in the AutoApply panel ──
    // This check runs BEFORE the pendingApplication check so it can override any stale
    // pendingApplication that was restored from a different job (e.g. Career17 while
    // we're on Mercury's page). The flag is always set by FILL_CURRENT_PAGE in bg.
    if (stored._aa_scrapeAndTailor) {
      await chrome.storage.local.remove(["_aa_scrapeAndTailor"]);
      const jobTitle = document.querySelector("h1")?.innerText?.trim()
        || document.title.replace(/^Job Application for\s*/i, "").split(" at ")[0].trim();
      // Extract company from URL slug: job-boards.greenhouse.io/{company}/jobs/{id}
      const urlParts = window.location.pathname.split("/").filter(Boolean);
      const companySlug = urlParts[0] || "";
      // Try to get a prettier company name from the title "... at CompanyName"
      const titleMatch = document.title.match(/ at ([^-|]+)$/i);
      const company = titleMatch ? titleMatch[1].trim() : companySlug;
      const jobDescription = scrapeGreenhouseJD();
      LOG("Self-scraping job from page:", jobTitle, "@", company);
      if (jobTitle || jobDescription) {
        const syntheticJob = {
          jobTitle,
          company,
          jobDescription,
          applyUrl: window.location.href,
          jobUrl:   window.location.href,
          _queuedAt: Date.now(),
          _scrapedFromPage: true,
        };
        // Clear any stale pendingApplication (may be for a different job) then set ours
        await chrome.storage.local.set({ pendingApplication: syntheticJob });
        window.__autoapply_ats_injected = false;
        LOG("Bootstrapped pendingApplication, re-running init");
        setTimeout(() => init(), 200);
        return;
      }
      // Couldn't scrape enough data — fall through to normal flow
      LOG("Self-scrape: no job title or JD found, continuing with existing pendingApplication");
    }

    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    // Remove pendingApplication immediately so any re-injection (SW restart) exits early
    chrome.storage.local.remove(["pendingApplication"]);
    console.log("AutoApply: Processing Greenhouse application for", pendingJob.jobTitle);
    showBanner("Preparing your application…", "ai");

    // ── Step 0: Navigate to the application form if we're on the posting page ──
    // job-boards.greenhouse.io/{co}/jobs/{id} shows the JD only — the actual
    // form is a click or navigation away. Detect this early and redirect so the
    // content script re-runs on the form page (still with pendingApplication set).
    if (!isOnGreenhouseApplicationForm()) {
      console.log("AutoApply: On Greenhouse posting page — navigating to application form");
      showBanner("Opening your application…", "ai", { subtext: "Navigating to the form" });
      // Re-store pendingApplication before navigating so the destination page can read it.
      // (It was removed above to guard against SW-restart double-injection on the SAME page,
      //  but cross-page navigation creates a fresh window context, so we need it again.)
      await chrome.storage.local.set({ pendingApplication: pendingJob });
      const navigated = await clickGreenhouseApplyButton();
      if (!navigated) {
        showBanner(
          "Couldn't find the Apply button — click it to continue.",
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
      showBanner("Filling in your details…", "ai", { subtext: "Tailoring your resume in the background" });
      await fillBasicFieldsOnly();

      // ── STEP 2: Show YOUR TURN immediately — no waiting ──
      // User can start reviewing the form right away.
      // Tailoring + resume upload continue silently in the background.
      showBanner("Your turn — review and submit when ready.", "user", {
        subtext: "Tailoring your resume in the background — extra fields will fill shortly…",
      });
      chrome.storage.local.remove(["pendingApplication"]);

      // ── Funnel Stage 2: Form filled ──────────────────────────────────────
      // Store lastFilledJob so the confirmation page can attribute Stage 4
      const lastFilledJobData = {
        id: pendingJob.id,
        jobTitle: pendingJob.jobTitle,
        company: pendingJob.company,
        jobUrl: pendingJob.jobUrl || window.location.href,
        // [AutoQA fix 2026-04-11] Include applyUrl so the floating panel's makeResumeKey
        // can find the correct tailoredResumeMap entry after pendingApplication is cleared.
        applyUrl: pendingJob.applyUrl || pendingJob.jobUrl || window.location.href,
        jobDescription: pendingJob.jobDescription || "",
        funnelFormFilledAt: new Date().toISOString(),
        _completionRecorded: false,
      };
      chrome.storage.local.set({ lastFilledJob: lastFilledJobData });
      chrome.runtime.sendMessage({ type: "FUNNEL_STAGE", stage: "formFilled", job: lastFilledJobData }).catch(() => {});

      // Watch for submission in the background
      watchSubmit({
        jobTitle: pendingJob.jobTitle,
        company: pendingJob.company,
        location: pendingJob.location || "",
        jobUrl: pendingJob.jobUrl || window.location.href,
        jobDescription: pendingJob.jobDescription || "",
        resumeFilename: pendingJob.resumeFilename || "resume.pdf",
      });

      // ── STEP 3: Tailoring + extra fields + resume — all non-blocking ──
      (async () => {
        try {
          const cacheData = await new Promise(resolve => chrome.storage.local.get(["lastTailoredResult", "lastTailoredJob"], resolve));
          const isSameJob = cacheData.lastTailoredJob?.applyUrl === window.location.href
            || (cacheData.lastTailoredJob?.jobTitle === pendingJob.jobTitle
                && cacheData.lastTailoredJob?.company === pendingJob.company);

          const tailoredData = await ((cacheData.lastTailoredResult && isSameJob)
            ? Promise.resolve({ tailoredResult: cacheData.lastTailoredResult })
            : sendMessageWithTimeout({
                type: "TAILOR_AND_FILL",
                job: { ...pendingJob, jobDescription },
              }, 90000).catch(err => ({ error: err.message })));

          if (tailoredData?.tailoredResult) {
            console.log("AutoApply: Background tailoring done — filling remaining fields");

            // ── Funnel Stage 3: Tailored resume created ───────────────────
            const matchScore = tailoredData.tailoredResult?.matchScore || 0;
            chrome.runtime.sendMessage({
              type: "FUNNEL_STAGE",
              stage: "resumeTailored",
              job: { id: pendingJob.id, jobTitle: pendingJob.jobTitle, company: pendingJob.company, matchScore },
            }).catch(() => {});
            // Update lastFilledJob with score so Stage 4 can include it
            chrome.storage.local.get(["lastFilledJob"], (d) => {
              if (d.lastFilledJob) {
                chrome.storage.local.set({ lastFilledJob: { ...d.lastFilledJob, matchScore, funnelResumeTailoredAt: new Date().toISOString() } });
              }
            });

            await fillGreenhouseForm(tailoredData.tailoredResult, pendingJob, jobDescription);

            // Try programmatic resume upload first
            const uploaded = await attemptResumeUpload();
            if (uploaded) {
              showBanner("Your turn — everything's filled in.", "user", {
                subtext: "Resume attached · Review each field and hit Submit.",
              });
            } else {
              // Show a download button in the banner — no forced wait, user grabs it when ready
              showBanner("Your turn — download your tailored resume below.", "user", {
                subtext: "Drag it into the resume field, then review and submit.",
              });
              // [Fix 2026-04-13 Cycle 6] Always include applyUrl so background.js uses
              // the URL-based map key (same key used when storing during tailoring).
              // Without applyUrl it fell back to company+title key which never matched.
              chrome.runtime.sendMessage({
                type: "DOWNLOAD_RESUME",
                job: {
                  applyUrl:  pendingJob.applyUrl || window.location.href,
                  company:   pendingJob.company,
                  jobTitle:  pendingJob.jobTitle,
                },
              });
            }

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
          } else {
            console.warn("AutoApply: Background tailoring returned no data —", tailoredData?.error);
            // Banner already shows YOUR TURN — no need to change it
          }
        } catch (bgErr) {
          console.warn("AutoApply: Background tailoring error (non-fatal):", bgErr.message);
        }
      })();

    } catch (err) {
      console.error("AutoApply: Greenhouse error", err);
      showBanner("Something went wrong — filling in basic info.", "error", { subtext: err.message || "Partial fill completed." });
      await fillBasicFieldsOnly();
      showBanner("Basic info filled — check the remaining fields.", "user", { subtext: "Some fields may need your input before submitting." });

      // Still watch for submission even in fallback path
      watchSubmit({
        jobTitle: pendingJob.jobTitle,
        company: pendingJob.company,
        location: pendingJob.location || "",
        jobUrl: pendingJob.jobUrl || window.location.href,
        jobDescription: pendingJob.jobDescription || "",
        resumeFilename: pendingJob.resumeFilename || "resume.pdf",
      });
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
    // NOTE: pendingApplication was already re-stored by the caller before this runs,
    // so the destination page will have access to it after any navigation.
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

    // Fallback 2: company-hosted page with embedded Greenhouse iframe
    // Pattern: company.com/careers?gh_jid=12345 + <script src="boards.greenhouse.io/embed/job_board/js?for=co">
    // + <iframe id="grnhse_iframe">
    const ghIframe = document.getElementById('grnhse_iframe');
    const ghJid = new URLSearchParams(window.location.search).get('gh_jid');
    if (ghIframe && ghJid) {
      // Extract company slug from the embed script tag
      const embedScript = document.querySelector('script[src*="boards.greenhouse.io/embed/job_board/js"]');
      const forMatch = embedScript?.src?.match(/[?&]for=([^&]+)/);
      const company = forMatch?.[1];
      if (company) {
        const appUrl = `https://boards.greenhouse.io/${company}/jobs/${ghJid}/application`;
        console.log("AutoApply: Embedded GH iframe detected — navigating to:", appUrl);
        window.location.href = appUrl;
        return true;
      }
      // Last resort: try scrolling to the iframe and let the user see it
      ghIframe.scrollIntoView({ behavior: 'smooth' });
      console.log("AutoApply: GH iframe found but company slug unknown — showing iframe");
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
    await fillAllFields(user, null, null, null);
  }

  async function fillGreenhouseForm(tailoredResult, job, jobDescription) {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};
    console.log("AutoApply: User profile keys:", Object.keys(user));
    await fillAllFields(user, tailoredResult, jobDescription, job);
  }

  async function fillAllFields(user, tailoredResult, jobDescription, jobData) {
    let filled = 0;

    // ── Basic fields (selector-based, most reliable for Greenhouse) ──
    // Issue #16 fix: Expanded phone selector to catch all variations
    const selectorFields = [
      { sel: 'input[name*="first_name"], input[id*="first_name"]', val: user.firstName },
      { sel: 'input[name*="last_name"], input[id*="last_name"]', val: user.lastName },
      { sel: 'input[name*="email"], input[id*="email"], input[type="email"]', val: user.email },
      // Expanded phone selectors: handles input[name="phone"], input[type="tel"], input[placeholder*="phone"], etc.
      { sel: 'input[name="phone"], input[name*="phone"], input[id*="phone"], input[type="tel"], input[placeholder*="phone" i]', val: user.phone },
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
      // Location fields
      { labels: ["city", "location (city)", "location city", "current city", "city of residence"], value: user.city || "Vancouver" },
      { labels: ["country", "country of residence"], value: user.country || "Canada" },
      { labels: ["address", "street address"], value: user.address || "" },
      { labels: ["zip", "postal code", "zip code"], value: user.postalCode || user.zip || "" },
    ];

    // Fill label fields synchronously
    for (const { labels, value } of labelFields) {
      if (value && fillByLabel(labels, value)) filled++;
    }

    // Fill cover letter — handle both textarea and Greenhouse file-upload style
    if (tailoredResult?.coverLetter) {
      let clFilled = false;

      // Check if there's already a cover letter textarea visible
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const label = getFieldLabel(ta).toLowerCase();
        if (label.includes("cover letter") || label.includes("cover_letter")) {
          setNativeValue(ta, tailoredResult.coverLetter);
          filled++;
          clFilled = true;
          console.log("AutoApply: Filled cover letter textarea");
          break;
        }
      }

      // If no textarea found, look for Greenhouse's file upload cover letter section
      // and click "Enter manually" to reveal the textarea
      if (!clFilled) {
        const labels = document.querySelectorAll("label, .field-label, h3, .application-label");
        for (const lbl of labels) {
          const txt = (lbl.textContent || "").toLowerCase();
          if (txt.includes("cover letter")) {
            // Find the "Enter manually" or "paste" link/button near this label
            const section = lbl.closest(".field") || lbl.closest(".section") || lbl.parentElement?.parentElement;
            if (!section) continue;
            const manualBtn = section.querySelector('a[href="#"], button, [role="button"]');
            // Look for buttons/links with text "Enter manually" or "paste" or "text"
            const allBtns = section.querySelectorAll("a, button, [role='button']");
            for (const btn of allBtns) {
              const btnTxt = (btn.textContent || "").toLowerCase().trim();
              if (btnTxt.includes("enter manually") || btnTxt.includes("paste") || btnTxt === "text") {
                console.log("AutoApply: Clicking 'Enter manually' for cover letter");
                btn.click();
                // Wait for textarea to appear, then fill it
                await new Promise(r => setTimeout(r, 500));
                const newTA = section.querySelector("textarea") || document.querySelector("textarea[name*='cover'], textarea[id*='cover']");
                if (newTA) {
                  setNativeValue(newTA, tailoredResult.coverLetter);
                  newTA.dispatchEvent(new Event("input", { bubbles: true }));
                  newTA.dispatchEvent(new Event("change", { bubbles: true }));
                  filled++;
                  clFilled = true;
                  console.log("AutoApply: Filled cover letter via 'Enter manually' textarea");
                }
                break;
              }
            }
            if (clFilled) break;
          }
        }
      }

      if (!clFilled) {
        console.log("AutoApply: Cover letter available but no textarea or manual entry found on page");
      }
    }

    // Issue #28/#32: Fill work experience entries if present in tailoredResult
    if (tailoredResult?.workExperience && Array.isArray(tailoredResult.workExperience) && tailoredResult.workExperience.length > 0) {
      const weCount = fillWorkExperienceFields(tailoredResult.workExperience);
      filled += weCount;
      console.log("AutoApply: Filled", weCount, "work experience field(s)");
    }

    // ── Education section ──
    const edu = tailoredResult?.education?.[0] || tailoredResult?.education;
    const parsedEdu = Array.isArray(edu) ? edu[0] : edu;
    if (parsedEdu) {
      const eduCount = fillEducationFields(parsedEdu);
      filled += eduCount;
      console.log("AutoApply: Filled", eduCount, "education field(s)");
    }

    // ── Select / dropdown fields ──
    // Greenhouse uses React Select v5. Dropdowns are filled via main world,
    // then text fields are re-filled after React re-renders (faster timing).
    const dropdownFields = [
      // [AutoQA fix 2026-04-07] Removed hardcoded "He/Him" default — only fill pronouns if user has set them explicitly
      { labels: ["pronouns"],                                                  value: user.pronouns },
      { labels: ["sponsorship", "immigration", "require immigration"],         value: user.requireSponsorship === "No" ? "No" : (user.requireSponsorship || "No") },
      { labels: ["state", "province", "reside in"],                           value: user.province || user.state || "British Columbia" },
      { labels: ["how did you", "hear about", "learn about", "first learn"],  value: user.howDidYouHear || "LinkedIn" },
      // [Fix 2026-04-13 Cycle 6] Diversity / EEO fields: ONLY fill if user has EXPLICITLY
      // set a value in their profile. Never use a fallback default ("Prefer not to disclose")
      // because the fuzzy dropdown matcher can match short words ("to" in "Prefer not to
      // disclose" → hits "Latino" / "Latinx" → selects wrong ethnicity option).
      // If the user hasn't set these, skip them entirely — leaving them blank is safer
      // than guessing or selecting an incorrect EEO category.
      { labels: ["gender"],      value: user.gender           || "" },
      { labels: ["race", "ethnicity"], value: user.ethnicity  || "" },
      { labels: ["veteran"],     value: user.veteranStatus    || "" },
      { labels: ["disability"],  value: user.disabilityStatus || "" },
      { labels: ["previously been employed", "worked here", "employed at", "worked at", "worked for", "worked before", "ever worked", "previously work", "former employee"], value: "No" },
    ];

    // ── Radio / checkbox questions (common in custom Greenhouse forms) ──
    // Match by question label text, then pick the best option.
    fillRadioCheckboxQuestions(user);

    // ── Free-text custom questions ──
    const customTextFields = [
      { labels: ["compensation", "salary", "salary expectation", "compensation expectation", "desired salary", "expected salary", "pay expectation"], value: extractMaxPayFromJD(jobDescription) || user.salaryExpectation || user.compensation || "" },
      { labels: ["earliest start", "when can you start", "available to start", "start availability"],  value: user.startDate || "2 weeks notice" },
    ];
    for (const { labels, value } of customTextFields) {
      if (value) fillByLabel(labels, value);
    }

    // Issue #6/#14: Generate AI answers for unfilled open-ended questions
    await fillBehavioralAnswersGreenhouse(tailoredResult, jobData);

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

        // Safety-net 3rd pass after 3s — catches slow React pages (e.g. Stripe, Coinbase)
        // that haven't fully settled by the first re-fill window.
        setTimeout(() => {
          fillRadioCheckboxQuestions(user);
          for (const { labels, value } of customTextFields) {
            if (value) fillByLabel(labels, value, true);
          }
          console.log("AutoApply: Safety-net 3rd fill pass complete");
        }, 3000);
      }, dropdownFillTimeMs);
    });

    console.log(`AutoApply: Initial fill of ${filled} fields completed`);
  }

  /* ─────────────── WORK EXPERIENCE FILLING ─────────────── */

  /**
   * Issue #28/#32: Fill work experience fields in Greenhouse.
   * Handles common field patterns like Job Title, Company, Location, Dates, Description.
   * Returns count of fields filled.
   */
  function fillWorkExperienceFields(workExperiences) {
    let filled = 0;
    if (!Array.isArray(workExperiences) || workExperiences.length === 0) {
      return 0;
    }

    // Look for work experience form sections
    // Common patterns: class contains "work", "experience", or specific GH patterns
    const allInputs = document.querySelectorAll("input[type='text'], textarea, input[type='date']");
    const allLabels = document.querySelectorAll("label, [class*='label']");

    // Map: label text → input element
    const labelMap = new Map();
    allLabels.forEach(label => {
      const text = (label.textContent || "").trim().toLowerCase();
      if (text.length > 2 && text.length < 100) {
        // Find associated input (could be child or sibling)
        let input = label.querySelector("input, textarea");
        if (!input) {
          // Try next sibling or parent's next element
          let el = label.nextElementSibling;
          if (el) input = el.querySelector ? el.querySelector("input, textarea") : (el.tagName.match(/input|textarea/i) ? el : null);
          if (!input) {
            const container = label.closest("div, fieldset");
            if (container) input = container.querySelector("input:not([type='hidden']), textarea");
          }
        }
        if (input) labelMap.set(text, input);
      }
    });

    // For the first work experience entry, try to fill common fields
    const we = workExperiences[0];
    if (!we) return 0;

    // Try common field label patterns
    const jobTitlePatterns = ["job title", "position", "title", "role"];
    const companyPatterns = ["company", "employer", "organization"];
    const locationPatterns = ["location", "city", "based"];
    // [GH-1 fix 2026-04-16] Removed unused dateStartPatterns / dateEndPatterns that
    // contained bare "start date" / "end date". Those loose patterns never got
    // wired up here, but keeping them around invited future regressions where
    // Education "Start date month/year" fields could be filled with
    // "2 weeks notice" via a substring match. Work-experience dates are handled
    // by fillWorkExperienceDates() which uses more specific patterns.
    const descriptionPatterns = ["description", "description of role", "responsibilities", "about this role"];

    // Fill Job Title
    for (const pattern of jobTitlePatterns) {
      for (const [labelText, input] of labelMap) {
        if (labelText.includes(pattern) && !input.value) {
          const title = we.role || we.title || "";
          if (title) {
            setNativeValue(input, title);
            filled++;
            break;
          }
        }
      }
      if (filled) break;
    }

    // Fill Company
    for (const pattern of companyPatterns) {
      for (const [labelText, input] of labelMap) {
        if (labelText.includes(pattern) && !input.value) {
          const company = we.company || "";
          if (company) {
            setNativeValue(input, company);
            filled++;
            break;
          }
        }
      }
      if (filled > 1) break;
    }

    // Fill Location
    for (const pattern of locationPatterns) {
      for (const [labelText, input] of labelMap) {
        if (labelText.includes(pattern) && !input.value) {
          const location = we.location || "";
          if (location) {
            setNativeValue(input, location);
            filled++;
            break;
          }
        }
      }
      if (filled > 2) break;
    }

    // Fill Description (textarea)
    for (const pattern of descriptionPatterns) {
      for (const [labelText, input] of labelMap) {
        if (labelText.includes(pattern) && !input.value && input.tagName === "TEXTAREA") {
          const desc = we.description || we.details || "";
          if (desc) {
            setNativeValue(input, desc);
            filled++;
            break;
          }
        }
      }
      if (filled > 3) break;
    }

    console.log("AutoApply: Filled", filled, "work experience field(s)");
    return filled;
  }

  /* ─────────────── EDUCATION FILLING ─────────────── */

  /**
   * Fill the education section on Greenhouse forms.
   * Handles school, degree, discipline/field of study, start/end dates.
   */
  function fillEducationFields(edu) {
    if (!edu) return 0;
    let filled = 0;

    const school = edu.school || edu.institution || edu.university || "";
    const degree = edu.degree || edu.qualification || "";
    const discipline = edu.fieldOfStudy || edu.discipline || edu.major || edu.field || "";
    const startYear = edu.startYear || edu.startDate?.toString()?.substring(0, 4) || "";
    const endYear = edu.endYear || edu.graduationYear || edu.endDate?.toString()?.substring(0, 4) || "";

    // Map label patterns to values
    const eduFields = [
      { labels: ["school", "university", "institution", "college", "school or university", "school name"], value: school },
      { labels: ["degree", "degree type", "degree level", "qualification"], value: degree },
      { labels: ["discipline", "field of study", "major", "area of study", "concentration"], value: discipline },
      { labels: ["start date year", "start year"], value: startYear },
      { labels: ["end date year", "end year", "graduation year", "year of graduation"], value: endYear },
    ];

    for (const { labels, value } of eduFields) {
      if (value && fillByLabel(labels, value)) filled++;
    }

    // Handle select/dropdown for start/end date month (leave as default if not specified)
    const startMonth = edu.startMonth || edu.startDate?.toString()?.split("-")?.[1] || "";
    const endMonth = edu.endMonth || edu.endDate?.toString()?.split("-")?.[1] || "";

    if (startMonth) {
      const startMonthSel = document.querySelector('select[name*="start_date_month"], select[id*="start_date_month"]');
      if (startMonthSel) { startMonthSel.value = startMonth; startMonthSel.dispatchEvent(new Event("change", {bubbles:true})); filled++; }
    }
    if (endMonth) {
      const endMonthSel = document.querySelector('select[name*="end_date_month"], select[id*="end_date_month"]');
      if (endMonthSel) { endMonthSel.value = endMonth; endMonthSel.dispatchEvent(new Event("change", {bubbles:true})); filled++; }
    }

    console.log("AutoApply: Education fill — school:", school, "degree:", degree, "discipline:", discipline);
    return filled;
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

    // 4. Native <select> hidden behind a styled overlay (common Greenhouse pattern)
    // The native <select> may be visually hidden but still functional via JS value setter.
    const nativeSelect = container.querySelector("select");
    if (nativeSelect) {
      const targetValue = Array.from(nativeSelect.options).find(
        (o) => o.text.toLowerCase().trim().includes(yesOrNo) || o.value.toLowerCase().trim().includes(yesOrNo)
      );
      if (targetValue) {
        const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
        if (nativeSelectValueSetter) nativeSelectValueSetter.call(nativeSelect, targetValue.value);
        else nativeSelect.value = targetValue.value;
        nativeSelect.dispatchEvent(new Event("input",  { bubbles: true }));
        nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        console.log("AutoApply: [native-select] Answered →", yesOrNo, "value:", targetValue.value);
        return;
      }
    }

    // 5. Custom styled "Select…" trigger div (Greenhouse React-Select replacement)
    // [GH-2 fix 2026-04-16] Previously:
    //   - Strict textContent === "select..." check missed triggers that showed
    //     "Select...", "Select…" (Unicode ellipsis), "Select an option", etc.
    //   - Plain .click() didn't reliably open React-Select components — those
    //     listen on mousedown/mouseup, not click.
    //   - Single 400ms timeout to find options was too fragile: if options took
    //     longer to render (slow laptop, heavy page) the dropdown stayed open
    //     with no selection and the Yes/No question fell through unanswered.
    // Fixed: more permissive trigger detection + dispatch mousedown/mouseup/click
    // event sequence + poll for options up to 2.5s with 100ms intervals.
    const selectTrigger = container.querySelector(
      "[class*='select__control'], [class*='SelectTrigger'], [class*='dropdown-toggle'], " +
      "[data-testid*='select'], [class*='custom-select']"
    ) || Array.from(container.querySelectorAll("div[class], button[class]")).find((el) => {
      const txt = (el.textContent || "").trim().toLowerCase();
      // Unicode ellipsis (…) and ASCII ellipsis (...) both common in placeholders
      return /^select(\s*(one|an option|…|\.\.\.))?\s*$/i.test(txt) ||
             el.getAttribute("aria-haspopup") === "listbox" ||
             el.getAttribute("role") === "combobox";
    });
    if (selectTrigger) {
      // Dispatch the full event sequence React-Select listens for. Plain click()
      // doesn't open react-select v5 dropdowns.
      ["mousedown", "mouseup", "click"].forEach((type) =>
        selectTrigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
      );
      console.log("AutoApply: [custom-select] Opened dropdown trigger for →", yesOrNo);

      // Poll for options instead of single-shot timeout — options may render
      // asynchronously on slow pages.
      const POLL_INTERVAL_MS = 100;
      const MAX_WAIT_MS = 2500;
      let elapsed = 0;
      const poll = () => {
        const optionEls = document.querySelectorAll(
          "[class*='select__option'], [class*='dropdown-item'], [role='option'], [class*='SelectItem'], li[class*='option']"
        );
        for (const opt of optionEls) {
          const optText = (opt.textContent || "").toLowerCase().trim();
          // Match word-boundary "yes"/"no" to avoid matching "notebook" etc.
          const yesNoRe = new RegExp(`\\b${yesOrNo}\\b`, "i");
          if (yesNoRe.test(optText) || optText === yesOrNo) {
            opt.click();
            console.log("AutoApply: [custom-select] Selected option →", yesOrNo);
            return true;
          }
        }
        return false;
      };
      const retryTick = () => {
        if (poll()) return;
        elapsed += POLL_INTERVAL_MS;
        if (elapsed < MAX_WAIT_MS) {
          setTimeout(retryTick, POLL_INTERVAL_MS);
        } else {
          console.log("AutoApply: [custom-select] Could not find matching option for →", yesOrNo, "(timed out after " + MAX_WAIT_MS + "ms)");
        }
      };
      setTimeout(retryTick, POLL_INTERVAL_MS);
      return;
    }

    console.log("AutoApply: answerYesNo — no clickable element found for", yesOrNo, "in", labelEl.textContent?.trim());
  }

  /* ─────────────── BEHAVIORAL ANSWER GENERATION (Issue #6/#14) ─────────────── */

  /**
   * Generate and fill behavioral answers for unfilled textareas and rich text editors
   */
  async function fillBehavioralAnswersGreenhouse(tailoredResult, jobData) {
    try {
      // Build rich resume context for AI answers — pull from tailored, parsed, and profile data
      const storageData = await chrome.storage.local.get(["userProfile", "parsedResume"]);
      const user = storageData.userProfile || {};
      const parsed = storageData.parsedResume || {};
      const tailored = tailoredResult?.tailoredResume || {};

      let resumeSummary = tailored.summary || parsed.summary || "";

      // Append experience highlights
      const expSource = tailored.experience || parsed.experience || [];
      if (expSource.length > 0) {
        const expLines = expSource.slice(0, 3).map(e => {
          const bullets = (e.bullets || []).slice(0, 2).join(". ");
          return `${e.role || ""} at ${e.company || ""} (${e.startDate || ""} - ${e.endDate || "Present"}): ${bullets}`;
        }).join("\n");
        resumeSummary += "\n\nRecent experience:\n" + expLines;
      }

      // Append skills
      const skillsSource = tailored.skills || parsed.skills || {};
      if (typeof skillsSource === "object" && !Array.isArray(skillsSource)) {
        const skillLines = Object.entries(skillsSource)
          .filter(([, v]) => Array.isArray(v) && v.length > 0)
          .map(([k, v]) => `${k}: ${v.join(", ")}`)
          .join(". ");
        if (skillLines) resumeSummary += "\n\nSkills: " + skillLines;
      }

      if (user.firstName) {
        resumeSummary += `\n\nCandidate name: ${user.firstName} ${user.lastName || ""}`;
        if (user.location) resumeSummary += `, located in ${user.location}`;
      }

      // Collect all unfilled textareas and contenteditable elements
      const candidates = [];
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        if (ta.value?.trim()) continue;
        const rawLabel = getFieldLabel(ta) || "";
        const label = rawLabel.toLowerCase();
        if (!label || label.length < 5) continue;
        if (label.includes("compensation") || label.includes("salary") || label.includes("start date")) continue;
        candidates.push({ element: ta, label: rawLabel, isContentEditable: false });
      }
      const editables = document.querySelectorAll("[contenteditable='true']");
      for (const el of editables) {
        if (el.textContent?.trim()) continue;
        const rawLabel = getFieldLabel(el) || "";
        const label = rawLabel.toLowerCase();
        if (!label || label.length < 5) continue;
        if (label.includes("compensation") || label.includes("salary") || label.includes("start date")) continue;
        candidates.push({ element: el, label: rawLabel, isContentEditable: true });
      }

      for (const { element, label, isContentEditable } of candidates) {
        console.log(`AutoApply: Generating answer for: "${label.substring(0, 60)}"`);
        try {
          const result = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 15000);
            chrome.runtime.sendMessage(
              {
                type: "ANSWER_CUSTOM_QUESTION",
                question: label,
                resumeSummary,
                jobTitle: jobData?.jobTitle || "",
                company: jobData?.company || "",
              },
              (r) => { clearTimeout(timer); resolve(r); }
            );
          });

          const answer = result?.answer;
          if (answer && answer.length > 10) {
            if (isContentEditable) {
              element.focus();
              document.execCommand("insertText", false, answer);
              element.dispatchEvent(new Event("input", { bubbles: true }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              setNativeValue(element, answer);
              element.dispatchEvent(new Event("input", { bubbles: true }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
            }
            console.log(`AutoApply: Filled answer (${answer.length} chars)`);
          }
        } catch (err) {
          console.log(`AutoApply: Answer generation failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.log(`AutoApply: Error in fillBehavioralAnswersGreenhouse: ${err.message}`);
      // Graceful degradation — continue even if behavioral answers fail
    }
  }

  /* ─────────────── FIELD VALIDATION ─────────────── */

  function validateFilledFields(user, tailoredResult) {
    console.log("AutoApply: Validating filled fields...");
    const emptyFields = [];

    // Check key selector fields (Issue #16: expanded phone selectors)
    const selectorFields = [
      { sel: 'input[name*="first_name"], input[id*="first_name"]', name: "First Name" },
      { sel: 'input[name*="last_name"], input[id*="last_name"]', name: "Last Name" },
      { sel: 'input[name*="email"], input[id*="email"], input[type="email"]', name: "Email" },
      { sel: 'input[name="phone"], input[name*="phone"], input[id*="phone"], input[type="tel"], input[placeholder*="phone" i]', name: "Phone" },
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
      // Use keyed lookup — prefer URL-based key so correct resume is always uploaded
      const pendingData = await chrome.storage.local.get(["pendingApplication", "lastTailoredJob"]);
      const job = pendingData.pendingApplication || pendingData.lastTailoredJob;
      // Always include page URL so background finds the right keyed entry
      const jobForLookup = { applyUrl: window.location.href, ...( job || {}) };
      const pdfResult = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: "GET_RESUME_PDF", job: jobForLookup }, resolve)
      );
      if (!pdfResult?.pdf) {
        LOG("No tailored resume PDF available — skipping programmatic upload");
        return false;
      }

      // Build the File object from stored base64, using the real tailored filename
      const base64Data = pdfResult.pdf;
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      const filename = pdfResult.filename || `Resume - ${job?.company || "Company"} - ${job?.jobTitle || "Role"}.pdf`;
      const file = new File([bytes], filename, { type: "application/pdf" });
      LOG("Built resume File:", filename, "size:", bytes.length, "bytes");

      const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));

      // ── Strategy 1: React __reactProps$ onChange on ANY file input (incl. hidden) ──
      // Calling React's own synthetic handler is safe even on hidden inputs — it doesn't
      // touch the DOM node's `files` property, so it won't corrupt the React reconciler.
      for (const inp of allFileInputs) {
        const reactKey = Object.keys(inp).find(k => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$"));
        const propsKey  = Object.keys(inp).find(k => k.startsWith("__reactProps$"));
        if (propsKey && inp[propsKey]?.onChange) {
          const dt = new DataTransfer();
          dt.items.add(file);
          inp[propsKey].onChange({
            target: { files: dt.files },
            currentTarget: { files: dt.files },
            preventDefault: () => {},
            stopPropagation: () => {},
            nativeEvent: new Event("change"),
            type: "change",
            bubbles: true,
          });
          LOG("Resume uploaded via React onChange on file input (key matched:", !!pdfResult.fromKey, ")");
          await new Promise(r => setTimeout(r, 600));
          // Verify it worked — Greenhouse sets aria-label or shows filename somewhere
          return true;
        }
      }

      // ── Strategy 2: Drop event on the Greenhouse upload dropzone ──
      // Greenhouse renders a visible drag-and-drop zone that listens to native drop events.
      // Find it by text content (the zone always mentions "resume" or "attach").
      const findDropzone = () => {
        // Try data-testid / known class patterns first
        const byAttr = document.querySelector(
          '[data-testid*="resume"], [data-testid*="upload"], ' +
          '[class*="resumeUpload"], [class*="resume-upload"], ' +
          '[class*="attachment"][class*="drop"], .drop-zone'
        );
        if (byAttr) return byAttr;
        // Fall back to innerText scan — find smallest element that mentions resume/attach/upload
        let best = null;
        let bestLen = Infinity;
        for (const el of document.querySelectorAll('div, label, section, li')) {
          const txt = (el.innerText || "").trim().toLowerCase();
          if (txt.length > 5 && txt.length < bestLen &&
              (txt.includes("resume") || txt.includes("attach") || txt.includes("drag") || txt.includes("upload"))) {
            best = el;
            bestLen = txt.length;
          }
        }
        return best;
      };
      const dropzone = findDropzone();
      if (dropzone) {
        LOG("Trying drop event on dropzone:", dropzone.tagName, dropzone.className.slice(0,60));
        const dt = new DataTransfer();
        dt.items.add(file);
        dropzone.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
        dropzone.dispatchEvent(new DragEvent("dragover",  { dataTransfer: dt, bubbles: true, cancelable: true }));
        dropzone.dispatchEvent(new DragEvent("drop",      { dataTransfer: dt, bubbles: true, cancelable: true }));
        LOG("Drop event dispatched on dropzone");
        await new Promise(r => setTimeout(r, 600));
        return true;
      }

      // ── Strategy 3: Visible file input — native DataTransfer (last resort) ──
      for (const inp of allFileInputs) {
        const style = window.getComputedStyle(inp);
        const rect  = inp.getBoundingClientRect();
        const hidden = style.display === "none" || style.visibility === "hidden"
          || parseFloat(style.opacity || "1") < 0.1 || rect.width < 2
          || inp.getAttribute("tabindex") === "-1" || inp.hasAttribute("aria-hidden");
        if (!hidden) {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
          const dt = new DataTransfer();
          dt.items.add(file);
          if (desc?.set) desc.set.call(inp, dt.files);
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new Event("input",  { bubbles: true }));
          LOG("Resume upload via native events on visible input");
          return true;
        }
      }

      // ── Strategy 4: Force-inject into ALL file inputs (hidden included) ──
      // Greenhouse and similar ATSs hide the native <input type="file"> behind a
      // custom drag-drop / click-to-upload UI (opacity:0, position:absolute, width:0).
      // The hidden input still processes files via the native property descriptor.
      // We must try it even if CSS hides it — this is the most reliable Greenhouse path.
      for (const inp of allFileInputs) {
        try {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
          const dt = new DataTransfer();
          dt.items.add(file);
          // Set files via native descriptor (bypasses React/framework guards)
          if (desc?.set) desc.set.call(inp, dt.files);
          else inp.files = dt.files;
          // Fire all relevant change events Greenhouse listens to
          inp.dispatchEvent(new Event("change",  { bubbles: true, cancelable: true }));
          inp.dispatchEvent(new Event("input",   { bubbles: true, cancelable: true }));
          inp.dispatchEvent(new InputEvent("change", { bubbles: true, cancelable: true }));
          LOG("Strategy 4: Forced resume inject on hidden file input");
          await new Promise(r => setTimeout(r, 800));
          // Verify Greenhouse's UI updated — it typically shows the filename or hides the placeholder
          const uploadUI = document.querySelector(
            '#resume_filename, [id*="resume"], [class*="filename"], ' +
            '[class*="upload-name"], [data-testid*="resume"], .attach-or-paste'
          );
          if (uploadUI) {
            const txt = uploadUI.textContent || uploadUI.value || "";
            LOG("Upload UI after Strategy 4:", txt.trim().slice(0, 60));
          }
          return true; // Best-effort — Greenhouse doesn't expose confirmation in DOM reliably
        } catch(e) {
          LOG("Strategy 4 error on input:", e.message);
        }
      }

      LOG("All upload strategies exhausted — user must attach resume manually");
      return false;
    } catch (err) {
      console.error("AutoApply: Resume upload error:", err);
      return false;
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

    chrome.storage.local.get(["_aa_batchProgress", "tailoredResumeMap", "pendingApplication", "lastTailoredJob", "lastTailoredResult"], (result) => {
      const bp = result._aa_batchProgress;
      const hasBatch = bp && bp.total > 0;
      // Check keyed map first — falls back to global slot for backward compat
      const currentJob = result.pendingApplication || result.lastTailoredJob;
      const resumeMap  = result.tailoredResumeMap || {};
      function _makeKey(job) {
        if (!job) return "default";
        const url = job.applyUrl || job.jobUrl || "";
        if (url) { try { const u = new URL(url); return (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80); } catch(_) {} }
        const co = (job.company  || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
        const ti = (job.jobTitle || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
        return (co + "_" + ti) || "default";
      }
      const resumeKey = _makeKey(currentJob);
      // [Fix 2026-04-13 Cycle 6] hasPdf must only be true when THIS job's PDF
      // is ready — not when any other job's PDF exists. The old fallback
      // `|| Object.keys(resumeMap).length > 0` caused the button to appear
      // for Job B using Job A's stale PDF. Also accept tailored text without
      // PDF so user can trigger a re-export download.
      const hasKeyedPdf = !!(resumeMap[resumeKey]?.pdf);
      const hasTailoredResult = !!(result.lastTailoredResult);
      const hasPdf = hasKeyedPdf || hasTailoredResult;

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

      const pct = hasBatch ? Math.round(((bp.current - 1) / bp.total) * 100) : 0;
      const progressBar = hasBatch ? `
        <div style="height:3px;background:rgba(255,255,255,0.2);margin:6px 0 4px;">
          <div style="height:100%;width:${pct}%;background:rgba(255,255,255,0.7);border-radius:2px;transition:width 0.4s;"></div>
        </div>` : "";

      const actorBadge = `<span style="font-size:11px;font-weight:600;background:rgba(255,255,255,0.18);border-radius:5px;padding:2px 8px;letter-spacing:0.2px;white-space:nowrap;">${cfg.icon} ${cfg.actor}</span>`;
      const statusMsg  = `<span style="font-size:13px;font-weight:500;opacity:0.95;">${message}</span>`;
      const timerEl    = isAi
        ? `<span id="aa-elapsed-timer" style="font-size:14px;font-weight:700;opacity:0.9;margin-left:auto;font-variant-numeric:tabular-nums;letter-spacing:1px;background:rgba(0,0,0,0.18);border-radius:5px;padding:1px 8px;">0:00</span>`
        : "";

      const subtextRow = opts.subtext
        ? `<div style="font-size:11px;opacity:0.75;margin-top:3px;padding-left:2px;">${opts.subtext}</div>`
        : "";

      // Resume download button — always shown when PDF is ready
      const pdfBtnStyle = `border:none;border-radius:6px;padding:5px 13px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,255,255,0.95);color:#4F46E5;letter-spacing:0.1px;`;
      const pdfBtn = hasPdf
        ? `<button id="aa-btn-download-resume" style="${pdfBtnStyle}">↓ Resume</button>`
        : "";

      const btnStyle = `border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;letter-spacing:0.1px;`;
      const pauseBtn = isAi
        ? `<button id="aa-btn-pause" style="${btnStyle}background:rgba(255,255,255,0.15);color:#fff;">Pause</button>`
        : "";
      const resumeBtn = opts.showResume
        ? `<button id="aa-btn-resume" style="${btnStyle}background:rgba(255,255,255,0.9);color:#92400E;">Resume</button>`
        : "";
      let actionRow = "";
      if (type === "error") {
        actionRow = `<div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.2);color:#fff;">Try again</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.85);border:1px solid rgba(255,255,255,0.25);">Reload resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.12);color:rgba(255,255,255,0.75);">Skip</button>
          ${pdfBtn}
        </div>`;
      } else if (type === "user") {
        actionRow = `<div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.2);color:#fff;">Fill again</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.85);border:1px solid rgba(255,255,255,0.25);">Reload resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.12);color:rgba(255,255,255,0.75);">Skip</button>
          ${pdfBtn}
        </div>`;
      } else if (isAi || resumeBtn || pdfBtn) {
        actionRow = `<div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">${pauseBtn}${resumeBtn}${pdfBtn}</div>`;
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
      // [Cycle 5 fix 2026-04-13] Fill again must work even when pendingApplication was
      // already consumed: set _aa_scrapeAndTailor so init() takes the self-scrape path
      // using the current URL + DOM-scraped JD. Without this flag, re-init short-circuits
      // with "No pending application found" when the user clicks Fill again after a
      // direct-visit flow (the common Greenhouse case).
      document.getElementById("aa-btn-retry")?.addEventListener("click", async () => {
        removeBanner();
        window.__autoapply_ats_injected = false;
        try {
          await new Promise(resolve => chrome.storage.local.get(["pendingApplication"], (d) => {
            if (d && d.pendingApplication) { resolve(); return; }
            chrome.storage.local.set({ _aa_scrapeAndTailor: true }, resolve);
          }));
        } catch (_) { /* noop */ }
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
        _downloadResumeForPage();
        const btn = document.getElementById("aa-btn-download-resume");
        if (btn) { btn.textContent = "↓ Download again"; btn.disabled = false; btn.style.opacity = "1"; }
      });
      document.getElementById("aa-btn-pause")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: true });
        showBanner("Paused — click Resume when you're ready.", "user", { showResume: true });
      });
      document.getElementById("aa-btn-resume")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: false });
        showBanner("Resuming…", "ai", { subtext: "Picking up where we left off" });
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
    chrome.storage.local.get(["tailoredResumeMap", "tailoredResumePdf", "pendingApplication", "lastTailoredJob", "_aa_batchProgress"], (result) => {
      const hasAnyPdf = !!(result.tailoredResumePdf) || !!(Object.keys(result.tailoredResumeMap || {}).length > 0);
      if (!hasAnyPdf) return;
      if (document.getElementById("aa-btn-download-resume")) return;
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

  // Proactively show the download button the moment resume is ready —
  // fires on either tailoredResumePdf (legacy) or tailoredResumeMap (new keyed map).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.tailoredResumePdf?.newValue && !changes.tailoredResumeMap?.newValue) return;
    LOG("Resume data ready — injecting persistent download button");
    injectOrRefreshDownloadButton();
  });

  /**
   * Watch for application submission confirmation on Greenhouse.
   * Detects success page and records the application in the application history.
   */
  function watchForSubmit(jobData) {
    const observer = new MutationObserver(() => {
      const pageText = document.body.innerText || "";
      const pageHtml = document.body.innerHTML || "";

      // Detect common Greenhouse success messages
      if (pageText.includes("Application Submitted") ||
          pageText.includes("Thank you for applying") ||
          pageText.includes("Your application has been received") ||
          pageText.includes("submitted successfully") ||
          pageHtml.includes("submit-success") ||
          pageHtml.includes("application-success")) {
        LOG("Detected Greenhouse application submitted confirmation!");
        observer.disconnect();

        // Record the application submission
        chrome.runtime.sendMessage({
          type: "RECORD_APPLICATION",
          data: {
            jobTitle: jobData.jobTitle || "",
            company: jobData.company || "",
            location: jobData.location || "",
            ats: "greenhouse",
            jobUrl: jobData.jobUrl || window.location.href,
            jobDescription: jobData.jobDescription || "",
            resumeFilename: jobData.resumeFilename || "resume.pdf",
          },
        }).catch(err => LOG("Failed to record application:", err.message));

        showBanner("Application submitted successfully!", "success");
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 600000); // Stop after 10 min
  }

  // Start watching for submission after form is filled
  // Call this once the form filling is complete
  const watchSubmit = (jobData) => watchForSubmit(jobData);

})();
