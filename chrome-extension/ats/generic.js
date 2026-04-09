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

  const AUTOAPPLY_URL = "https://autoapply-ai-delta.vercel.app";

  console.log("AutoApply: Generic ATS script loaded on", window.location.href);
  try { AALog && AALog.state("ats.generic.loaded", { url: window.location.href, isChildFrame: window !== window.top }); } catch(_){}
  try { AALog && AALog.state("ats.loaded", { url: window.location.href, isChildFrame: window !== window.top }); } catch(_){}

  // ── Are we running inside an iframe? ──
  // If so, skip the full init() flow (banners, navigation, tailoring).
  // Just fill whatever form fields are in this frame's document, and
  // listen for pendingApplication to be set if it isn't yet.
  const isChildFrame = (window !== window.top);

  if (isChildFrame) {
    // If this iframe is SAME-ORIGIN, the parent frame's generic.js can access
    // our contentDocument via getAccessibleDocuments() and will fill us directly.
    // Skip the child frame fill to avoid double-filling.
    try {
      const _parentCheck = window.top.document; // throws if cross-origin
      console.log("AutoApply: Same-origin child frame — parent will fill via getAccessibleDocuments()");
      return; // parent handles it
    } catch (e) {
      // Cross-origin — we must fill ourselves (parent cannot access our DOM)
    }

    // Only run child-frame fill for actual Ashby embed pages.
    // Other cross-origin iframes (Drift chat, GTM, analytics, etc.) must be skipped.
    if (!window.location.href.includes("ashbyhq.com")) {
      console.log("AutoApply: Skipping non-Ashby cross-origin frame:", window.location.href.substring(0, 80));
      return;
    }

    console.log("AutoApply: Cross-origin child frame — filling independently:", window.location.href);
    (async () => {
      let stored = await chrome.storage.local.get(["pendingApplication", "userProfile"]);
      if (!stored.pendingApplication) {
        // No pending application yet — wait for it via storage listener
        await new Promise((resolve) => {
          const listener = (changes) => {
            if (changes.pendingApplication?.newValue) {
              chrome.storage.onChanged.removeListener(listener);
              resolve();
            }
          };
          chrome.storage.onChanged.addListener(listener);
          // Auto-resolve after 60s to avoid leaking listener
          setTimeout(resolve, 60000);
        });
        stored = await chrome.storage.local.get(["pendingApplication", "userProfile"]);
      }
      if (!stored.pendingApplication) return;

      // Save user data now — pendingApplication may be cleared by the main frame while we wait
      const user = stored.userProfile || {};

      // Step 1: If we're on the Ashby overview page, click "Apply for this Job"
      // (Ashby embed shows the job description first; the form is one click away)
      await sleep(1500); // let Ashby overview render first
      const applyBtnCandidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const btn of applyBtnCandidates) {
        const text = (btn.textContent || "").trim().toLowerCase();
        if (text === "apply for this job" || text === "apply now" || text === "apply") {
          console.log("AutoApply: Child frame clicking apply button:", btn.textContent.trim());
          btn.click();
          await sleep(500);
          break;
        }
      }

      // Step 2: Poll until Ashby's React form renders (up to 20s)
      console.log("AutoApply: Child frame waiting for application form to render...");
      const formReady = await waitForAshbyForm(20000);
      if (!formReady) {
        // ── Diagnostic dump — tells us WHY the form wasn't found ──
        const allInputs   = queryAllDeep("input").length;
        const allLabels   = queryAllDeep("label").length;
        const allEditable = queryAllDeep("[contenteditable], [role='textbox']").length;
        const subFrames   = Array.from(document.querySelectorAll("iframe"));
        console.warn(`AutoApply: Child frame timed out. DOM: ${allInputs} inputs, ${allLabels} labels, ${allEditable} editables, ${subFrames.length} sub-iframes`);
        subFrames.forEach((fr, i) => {
          try { const d = fr.contentDocument; console.warn(`  sub-iframe[${i}] same-origin, inputs: ${d?.querySelectorAll("input").length}`); }
          catch (e) { console.warn(`  sub-iframe[${i}] cross-origin: ${fr.src?.substring(0,80)}`); }
        });
        console.warn("AutoApply: Child frame body HTML:", document.body?.innerHTML?.substring(0, 4000));
        await chrome.storage.local.set({ _ashby_iframe_filled: 0 });
        return;
      }
      await sleep(500); // brief settle

      // Step 3: Fill the form
      console.log("AutoApply: Child frame: form detected, filling fields...");
      let filled = fillBasicProfileInDoc(user, document);
      if (filled === 0) {
        await sleep(2000); // React still settling — retry once
        filled = fillBasicProfileInDoc(user, document);
      }
      // Province dropdown
      const provinceValue = user.province || "British Columbia";
      if (fillSelectByLabel(["province", "territory", "province or territory", "state or province", "province/territory", "located in"], provinceValue, document)) {
        filled++;
      }
      // Button-style Yes/No questions (criminal record → No, work eligibility → Yes)
      const btnFilled = await fillButtonStyleYesNo(document);
      filled += btnFilled;
      console.log(`AutoApply: Child frame filled ${filled} fields`);

      // Step 4: Attempt resume upload, fall back to download
      const uploaded = await attemptResumeUpload();
      if (!uploaded) {
        // Download to user's Downloads folder so they can drag & drop it in
        const jobData = stored.pendingApplication;
        if (jobData) {
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_RESUME",
            job: { company: jobData.company, jobTitle: jobData.jobTitle },
          });
          console.log("AutoApply: Child frame triggered resume download");
        }
      } else {
        console.log("AutoApply: Child frame uploaded resume programmatically");
      }

      // Step 5: Signal main frame with result
      await chrome.storage.local.set({ _ashby_iframe_filled: filled });
    })();
    return; // ← don't run main init() flow
  }

  // Show banner immediately so the user knows AutoApply is active on this page
  showBanner("Getting ready...", "ai", { subtext: "Waiting for the page to finish loading..." });
  setTimeout(() => init(), 3000);

  /* ─────────────── SHADOW DOM + IFRAME HELPERS ─────────────── */

  /**
   * Like querySelectorAll but also searches inside open shadow roots recursively.
   * Ashby and other modern ATS frameworks may render form elements inside
   * web components (shadow DOM) that are invisible to plain querySelectorAll.
   */
  function queryAllDeep(selector, root = document) {
    const results = [];
    const visited = new WeakSet();
    function traverse(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      try {
        Array.from(node.querySelectorAll(selector)).forEach(el => results.push(el));
        Array.from(node.querySelectorAll("*")).forEach(el => {
          if (el.shadowRoot) traverse(el.shadowRoot);
        });
      } catch (e) { /* ignore inaccessible shadow roots */ }
    }
    traverse(root);
    return results;
  }

  function queryDeep(selector, root = document) {
    return queryAllDeep(selector, root)[0] || null;
  }

  /**
   * Returns all document roots we can access: main document + same-origin iframes.
   * Cross-origin iframes (e.g. jobs.ashbyhq.com inside loopio.com) are skipped
   * here but handled separately via the manifest all_frames injection.
   */
  function getAccessibleDocuments() {
    const docs = [document];
    try {
      Array.from(document.querySelectorAll("iframe")).forEach(fr => {
        try {
          const doc = fr.contentDocument || fr.contentWindow?.document;
          if (doc && doc !== document && doc.readyState !== "uninitialized") {
            docs.push(doc);
          }
        } catch (e) { /* cross-origin — handled by manifest all_frames injection */ }
      });
    } catch (e) { /* ignore */ }
    return docs;
  }

  /**
   * Detect if the current page is Ashby-powered.
   * Checks both URL parameters AND DOM signals so this works even after
   * an SPA navigation that removes the ashby_jid query parameter.
   */
  function detectAshbyPage() {
    const href = window.location.href;
    if (href.includes("ashby_jid=") || href.includes("ashbyhq.com")) return true;

    // DOM: Ashby web component or embed marker
    if (document.querySelector('ashby-application-form, [data-ashby-embed], [data-ashby]')) return true;

    // DOM: iframe sourced from ashbyhq.com (cross-origin embed)
    const frames = Array.from(document.querySelectorAll("iframe"));
    for (const fr of frames) {
      const src = (fr.src || "").toLowerCase();
      if (src.includes("ashbyhq.com") || src.includes("ashby")) return true;
    }

    // DOM: "Type here..." placeholder — Ashby's fingerprint on text inputs
    if (document.querySelector('input[placeholder*="here" i], input[placeholder*="type" i]')) return true;

    // DOM: "Application Details" heading visible on screen (Ashby section header)
    const headingEls = document.querySelectorAll("h1, h2, h3, h4, p, div, span, strong");
    for (const el of headingEls) {
      if (el.children.length > 3) continue;
      const text = (el.textContent || "").trim().toLowerCase();
      if (text === "application details" || text.startsWith("application details")) {
        const s = window.getComputedStyle(el);
        if (s.display !== "none" && s.visibility !== "hidden") return true;
      }
    }

    return false;
  }

  /** Detect iCIMS job application pages by URL */
  function detectICIMS() {
    return window.location.href.toLowerCase().includes("icims.com");
  }

  /** Detect Oracle Taleo job application pages by URL */
  function detectTaleo() {
    return window.location.href.toLowerCase().includes("taleo.net");
  }

  /* ─────────────── SIGN-IN WALL DETECTION ─────────────── */

  /**
   * Returns true if the page is presenting a sign-in / registration wall
   * instead of an application form. When detected, AutoApply skips filling
   * and prompts the user to log in manually.
   *
   * Heuristics (any one is enough to flag a sign-in wall):
   *  1. URL contains login / signin / register / auth patterns
   *  2. A password <input> is present in the DOM
   *  3. Very few visible inputs (≤3) AND recognisable sign-in text on the page
   *  4. Sign-in text present AND no resume upload AND no textareas/rich inputs
   */
  function detectSignInWall() {
    // Signal 1: URL pattern
    const url = window.location.href.toLowerCase();
    const loginUrlPatterns = ["login", "signin", "sign-in", "/register", "/auth", "account/create", "new-user", "createaccount"];
    if (loginUrlPatterns.some(p => url.includes(p))) return true;

    // Signal 2: Password input visible in the DOM
    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"]'))
      .filter(el => el.offsetParent !== null);
    if (passwordInputs.length > 0) return true;

    // Shared: page text and sign-in keywords
    const pageText = (document.body?.textContent || "").toLowerCase();
    const signInKeywords = ["sign in", "log in", "login to apply", "create an account", "register to apply", "create account to apply"];
    const hasSignInText = signInKeywords.some(k => pageText.includes(k));

    // Shared: apply button detection (job listing pages always have one — never flag them as login walls)
    const applyButtonTexts = new Set(["apply", "apply now", "apply today", "apply here", "apply for this job", "apply for this role", "apply externally", "start application"]);
    const hasApplyButton = Array.from(document.querySelectorAll('a[href], button, [role="button"]'))
      .some(el => {
        const text = (el.textContent?.trim() || "").toLowerCase().replace(/\s+/g, " ");
        return applyButtonTexts.has(text) || text.startsWith("apply for ") || text.startsWith("apply with ");
      });

    // Signal 3: Very few visible inputs + sign-in text
    // Guard: if there's a visible Apply button, this is a job listing page — not a sign-in wall
    const visibleInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
      .filter(el => el.offsetParent !== null);
    if (visibleInputs.length <= 3 && hasSignInText && !hasApplyButton) return true;

    // Signal 4: Sign-in text + no resume upload + no application-style text inputs
    // BUT: if there is a visible Apply button on the page this is a job listing, not a sign-in wall
    const hasResumeUpload = !!document.querySelector('input[type="file"]');
    const hasRichInputs = !!document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (hasSignInText && !hasResumeUpload && !hasRichInputs && visibleInputs.length <= 5 && !hasApplyButton) return true;

    return false;
  }

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
    // ── Check all accessible document roots (main + same-origin iframes) ──
    const docs = getAccessibleDocuments();

    for (const doc of docs) {
      // ── Ashby-specific: "Type here..." placeholder is unique to Ashby form inputs ──
      if (queryAllDeep('input[placeholder*="here" i], input[placeholder*="type" i]', doc).length > 0) return true;

      // ── Ashby-specific: "Application Details" heading ──
      const allEls = doc.querySelectorAll('p, div, span, strong, h1, h2, h3, h4, h5, h6, section');
      for (const el of allEls) {
        if (el.children.length > 3) continue;
        const text = (el.textContent || "").trim().toLowerCase();
        if (text === "application details" || text === "application form" ||
            text.startsWith("application details")) {
          const style = window.getComputedStyle(el);
          if (style.display !== "none" && style.visibility !== "hidden") return true;
        }
      }

      // ── Labels with common first-field names ──
      const labels = queryAllDeep("label", doc);
      for (const lbl of labels) {
        const text = (lbl.textContent || "").replace(/\*/g, "").trim().toLowerCase();
        if (text === "full name" || text === "first name" || text === "email" ||
            text === "email address" || text === "phone" || text === "resume") {
          const style = window.getComputedStyle(lbl);
          if (style.display !== "none" && style.visibility !== "hidden") return true;
        }
      }

      // ── 2+ visible non-hidden inputs ──
      const allInputs = queryAllDeep(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])' +
        ':not([type="file"]):not([type="submit"]):not([type="button"])' +
        ':not([type="reset"]):not([type="image"]):not([type="range"]):not([type="color"]), textarea',
        doc
      );
      let visibleCount = 0;
      for (const el of allInputs) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        visibleCount++;
        if (visibleCount >= 2) return true;
      }

      // ── Explicit <form> with inputs ──
      const forms = doc.querySelectorAll("form");
      for (const f of forms) {
        const style = window.getComputedStyle(f);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (f.querySelector("input:not([type='hidden']), textarea, select")) return true;
      }
    }

    // ── Cross-origin iframe with Ashby (can't access DOM, but src gives it away) ──
    const frames = document.querySelectorAll("iframe");
    for (const fr of frames) {
      const src = (fr.src || "").toLowerCase();
      if (src.includes("ashbyhq.com") || src.includes("ashby")) return true;
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
      const docs = getAccessibleDocuments();

      for (const doc of docs) {
        // Signal 1: "Type here..." placeholder
        if (queryAllDeep('input[placeholder*="here" i], input[placeholder*="type" i]', doc).length > 0) return true;

        // Signal 2: "Application Details" heading
        const allEls = doc.querySelectorAll('p, div, span, strong, h1, h2, h3, h4');
        for (const el of allEls) {
          if (el.children.length > 3) continue;
          const text = (el.textContent || "").trim().toLowerCase();
          if (text === "application details" || text.startsWith("application details")) {
            const style = window.getComputedStyle(el);
            if (style.display !== "none" && style.visibility !== "hidden") return true;
          }
        }

        // Signal 3: Full Name / Email label visible
        const labels = queryAllDeep("label", doc);
        for (const lbl of labels) {
          const text = (lbl.textContent || "").replace(/\*/g, "").trim().toLowerCase();
          if (text === "full name" || text === "first name" || text === "email" || text === "email address") {
            const style = window.getComputedStyle(lbl);
            if (style.display !== "none" && style.visibility !== "hidden") return true;
          }
        }

        // Signal 4: 2+ visible inputs
        const inputs = queryAllDeep(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])' +
          ':not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea',
          doc
        );
        let cnt = 0;
        for (const el of inputs) {
          const s = window.getComputedStyle(el);
          if (s.display !== "none" && s.visibility !== "hidden") { cnt++; if (cnt >= 2) return true; }
        }
      }

      // Signal 5: cross-origin Ashby iframe detected (form is in the iframe, not here)
      const frames = document.querySelectorAll("iframe");
      for (const fr of frames) {
        const src = (fr.src || "").toLowerCase();
        if (src.includes("ashbyhq.com") || src.includes("ashby")) return true;
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

    // Helper: arm background.js to inject into any new tab that opens from a click
    async function armChildTabExpectation() {
      try {
        await new Promise(resolve => chrome.runtime.sendMessage({ type: "EXPECT_CHILD_TAB" }, resolve));
      } catch (_) {}
    }

    // Pass 1: exact text match
    for (const el of candidates) {
      const text = (el.textContent?.trim() || "").toLowerCase().replace(/\s+/g, " ");
      if (exactMatches.has(text)) {
        console.log("AutoApply: Clicking exact Apply button:", el.textContent?.trim());
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(300);
        await armChildTabExpectation();
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
        await armChildTabExpectation();
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
        await armChildTabExpectation();
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
        await armChildTabExpectation();
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
  async function waitForApplicationForm(timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isOnApplicationForm()) return true;
      await sleep(600);
    }
    return false;
  }

  /**
   * Scrape enough job info from the current ATS page to build a synthetic
   * pendingApplication so the user can re-trigger tailoring + fill without
   * returning to LinkedIn. Works for Ashby, Greenhouse, Lever, iCIMS, etc.
   */
  function scrapeJobInfoFromPage() {
    // Title — try structured selectors first, fall back to h1/h2
    const titleEl = document.querySelector(
      'h1[class*="title" i], h1[class*="job" i], h2[class*="title" i], ' +
      '[data-qa="posting-name"], [class*="posting-title"], [class*="job-title"], ' +
      '[class*="jobTitle"], h1, h2'
    );
    const title = titleEl?.innerText?.trim().split("\n")[0] || document.title.replace(/[\-–|].*$/, "").trim();
    if (!title || title.length < 3) return null;

    // Company — try meta tags, page content, or domain
    const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
    const companyEl  = document.querySelector(
      '[class*="company-name"], [class*="companyName"], [class*="employer"], ' +
      '.posting-categories .sort-by-team, [class*="org-name"]'
    );
    const domainCompany = location.hostname
      .replace(/^(jobs\.|careers\.|apply\.)/, "")
      .replace(/\.(com|co|io|net|org|ca)$/, "")
      .split(".")[0];
    const company = ogSiteName
      || companyEl?.innerText?.trim()
      || (domainCompany ? domainCompany.charAt(0).toUpperCase() + domainCompany.slice(1) : "Company");

    // JD — reuse scrapeGenericJD if available, else grab all paragraph text
    const jd = (typeof scrapeGenericJD === "function" ? scrapeGenericJD() : "") ||
      Array.from(document.querySelectorAll("p, li"))
        .map(e => e.innerText?.trim())
        .filter(t => t && t.length > 40)
        .slice(0, 60)
        .join("\n")
        .slice(0, 6000);

    return {
      jobTitle: title,
      company,
      jobDescription: jd,
      jobUrl: location.href,
      source: "direct",
      _queuedAt: Date.now(),
    };
  }

  async function init() {
    // ── Sign-in wall check FIRST — before anything else ──
    // Must run before the pendingApplication check so login pages always get
    // a clear banner even when the batch has already moved on (pendingApplication
    // may have been overwritten by the next job's 3-second window).
    if (detectSignInWall()) {
      console.warn("AutoApply: Sign-in wall detected at", location.href);
      try { AALog && AALog.state("ats.signinWall.detected", { url: location.href }); } catch(_){}
      showBanner(
        "⚠️ Login required — AutoApply can't apply here automatically.",
        "user",
        {
          subtext: "This job site requires you to log in or create an account. Apply manually or skip this job.",
        }
      );
      return;
    }

    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found — offering re-trigger");
      // Try to scrape job info from the current ATS page so the user can
      // re-trigger tailoring + form-fill without going back to LinkedIn.
      const scraped = scrapeJobInfoFromPage();
      showBanner(
        scraped ? `${scraped.jobTitle} — ready to apply` : "No active application found.",
        "user",
        {
          subtext: scraped
            ? "AutoApply can fill and tailor this application for you."
            : "Open a job from LinkedIn with AutoApply, or use the button below.",
          applyNowJob: scraped,
        }
      );
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing generic application for", pendingJob.jobTitle);
    showBanner("Opening application...", "ai");

    // Detect Ashby embedded pages — checks URL AND DOM signals
    // (DOM check handles SPA navigation that removes ashby_jid= from URL)
    const isAshbyPage = detectAshbyPage();
    const isICIMS     = detectICIMS();
    const isTaleo     = detectTaleo();

    // ── Fire tailoring immediately in the background ──
    // We don't wait for it here — form fills happen in parallel so there's no
    // visible delay. We only await the result when we need it for resume upload.
    const pageJD = scrapeGenericJD();
    const jobDescription = pageJD || pendingJob.jobDescription;
    // Store salary range in batch progress so banner can display 💰 pill
    storeSalaryRangeInProgress(extractPayRangeFromJD(jobDescription));
    try { AALog && AALog.api("ats.tailor.request", { company: pendingJob.company, jobTitle: pendingJob.jobTitle, jdLen: (jobDescription || "").length, jdSource: pageJD ? "ats-page" : "linkedin" }); } catch(_){}
    const _tailorStart = Date.now();
    // Check if we already have a valid tailored result for this job — skip re-tailoring on retry
    const cacheData = await new Promise(resolve => chrome.storage.local.get(["lastTailoredResult", "lastTailoredJob"], resolve));
    const isSameJob = cacheData.lastTailoredJob?.applyUrl === window.location.href
      || (cacheData.lastTailoredJob?.jobTitle === pendingJob.jobTitle
          && cacheData.lastTailoredJob?.company === pendingJob.company);

    if (!isSameJob) {
      chrome.storage.local.remove(["tailoredResumePdf", "tailoredResumeFilename"]);
    }

    const tailoringPromise = (cacheData.lastTailoredResult && isSameJob)
      ? Promise.resolve({ tailoredResult: cacheData.lastTailoredResult })
      : sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 90000).then(r => {
        if (r?.error) { console.error("AutoApply: Tailoring error:", r.error); try { AALog && AALog.error("ats.tailor.error", { error: r.error, ms: Date.now() - _tailorStart }); } catch(_){} }
        else { try { AALog && AALog.api("ats.tailor.response", { ms: Date.now() - _tailorStart, keys: r?.tailoredResult ? Object.keys(r.tailoredResult) : [], hasResult: !!r?.tailoredResult }); } catch(_){} }
        return r;
      }).catch(err => {
        console.error("AutoApply: Tailoring failed:", err.message);
        try { AALog && AALog.error("ats.tailor.exception", { message: err.message, ms: Date.now() - _tailorStart }); } catch(_){}
        return null;
      });

    // Detect if Ashby form is in a cross-origin iframe (the common embed pattern).
    // In that case, the child frame's generic.js handles the fill — this main-frame
    // instance only manages the banner and waits for tailoring.
    const hasAshbyIframe = Array.from(document.querySelectorAll("iframe")).some(fr => {
      const src = (fr.src || "").toLowerCase();
      return src.includes("ashbyhq.com");
    });

    try {
      // ── Step 0: Navigate to the application form ──
      if (isAshbyPage) {
        if (hasAshbyIframe) {
          // Form is inside the cross-origin Ashby iframe — child frame fills it.
          // Main frame shows status and waits for the child to signal completion.
          await chrome.storage.local.remove(["_ashby_iframe_filled"]); // clear any stale result
          showBanner("Opening Ashby form...", "ai", { subtext: "Filling your details in the embedded form..." });
          await activateAshbyTab();

          // Wait for child frame to set _ashby_iframe_filled in storage (up to 35s)
          // Child frame timing: 1.5s sleep + up to 20s form poll + fill + resume = ~25s worst case
          const iframeFilled = await new Promise((resolve) => {
            const listener = (changes) => {
              if ("_ashby_iframe_filled" in changes) {
                chrome.storage.onChanged.removeListener(listener);
                resolve(changes._ashby_iframe_filled.newValue || 0);
              }
            };
            chrome.storage.onChanged.addListener(listener);
            setTimeout(() => {
              chrome.storage.onChanged.removeListener(listener);
              resolve(-1); // timeout — unknown result
            }, 35000);
          });

          chrome.storage.local.remove(["_ashby_iframe_filled"]);
          // NOTE: pendingApplication is intentionally kept so Try Again works.
          // It will be cleared when the user clicks Skip Job.

          if (iframeFilled > 0) {
            showBanner(`Form filled (${iframeFilled} fields) — review and submit when ready.`, "user",
              { subtext: "AutoApply stops here — you stay in control of the final submit." });
          } else if (iframeFilled === 0) {
            showBanner("Couldn't fill this form automatically — try refreshing and running again.", "user",
              { subtext: "Open DevTools (F12 → Console) and share the logs to diagnose." });
          } else {
            // Timeout — still filling in background
            showBanner("Still working — check the form fields in a moment.", "user",
              { subtext: "AutoApply may still be filling. Scroll down to see the form." });
          }
          return;
        }

        // Ashby rendered directly in main DOM (not in iframe)
        showBanner("Opening application form...", "ai", { subtext: "Tailoring resume in background..." });

        // Ensure Application tab is active
        await activateAshbyTab();

        // Fixed wait — let React fully render after tab switch
        await sleep(2500);

        // No detection gate. Fall straight through to filling.
      } else if (!isOnApplicationForm()) {
        // Generic non-Ashby page: scroll and find Apply button
        showBanner("Opening application form...", "ai", { subtext: "Tailoring resume in background..." });
        const clicked = await clickApplyOnPosting();
        if (!clicked) {
          showBanner("Click the Apply button on this page to open the application form.", "user",
            { subtext: "AutoApply will detect the form and continue automatically." });
        } else {
          showBanner("Waiting for application form to load...", "ai",
            { subtext: "Tailoring resume in background..." });
        }
        const formReady = await waitForApplicationForm(45000);
        if (!formReady) {
          showBanner("Couldn't find the application form — navigate to it manually and it will continue.", "user");
          return;
        }
        await sleep(500);
      }

      // ── Step 1: Fill basic fields immediately (no tailoring needed) ──
      if (isICIMS) {
        showBanner("iCIMS detected — filling basic fields...", "ai", { subtext: "Partial fill only — please review all fields before submitting." });
      } else if (isTaleo) {
        showBanner("Taleo detected — filling basic fields...", "ai", { subtext: "Partial fill only — please review all fields before submitting." });
      } else {
        showBanner("Filling your details...", "ai", { subtext: "Tailoring resume in background..." });
      }
      try { AALog && AALog.form("ats.fillBasic.start", { url: location.href, ats: isICIMS ? "icims" : isTaleo ? "taleo" : "generic" }); } catch(_){}
      const basicFilled = await fillBasicProfile();
      // ATS-specific supplemental fill — catches fields missed by the generic label matcher
      if (isICIMS || isTaleo) {
        const storedProfile = await chrome.storage.local.get(["userProfile", "parsedResume"]);
        const atsFilled = isICIMS
          ? fillICIMSForm(storedProfile.userProfile || {})
          : fillTaleoForm(storedProfile.userProfile || {});
        try { AALog && AALog.form("ats.fillAtsSpecific.done", { ats: isICIMS ? "icims" : "taleo", fieldsFilled: atsFilled }); } catch(_){}

        // Fill Work History section (iCIMS only — Taleo typically pre-populates from profile)
        if (isICIMS) {
          const workExp = storedProfile.parsedResume?.workExperience || [];
          if (workExp.length > 0) {
            showBanner("Filling iCIMS Work History...", "ai", { subtext: `Adding ${workExp.length} work experience entr${workExp.length === 1 ? "y" : "ies"}...` });
            const whFilled = await fillICIMSWorkHistory(workExp);
            try { AALog && AALog.form("ats.icims.workHistory.done", { entries: whFilled }); } catch(_){}
          }
        }
      }
      try { AALog && AALog.form("ats.fillBasic.done", { fieldsFilled: basicFilled }); } catch(_){}

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
        try { AALog && AALog.form("ats.fillTailored.start", { keys: Object.keys(tailoredData.tailoredResult || {}) }); } catch(_){}
        await fillGenericForm(tailoredData.tailoredResult, pendingJob);
        try { AALog && AALog.form("ats.fillTailored.done", {}); } catch(_){}
      } else {
        // Tailoring failed after all retries — show amber fallback banner
        const reason = tailoredData?.error || "API unavailable";
        console.warn("AutoApply: Tailoring failed —", reason, "— basic info filled, no tailored resume");
        try { AALog && AALog.error("ats.fillTailored.noData", { reason }); } catch(_){}
        showBanner(
          "AI tailoring failed — basic info filled, review before submitting.",
          "user",
          { subtext: `Error: ${reason.substring(0, 80)}. Your contact info has been filled — complete the rest manually.` }
        );
      }

      // ── Multi-page auto-advance ────────────────────────────────────────────────
      // After filling the current page, click Next/Continue if present and repeat
      // until we reach the final page (Submit visible, or no more Next button).
      // We stop BEFORE clicking Submit — user stays in control of the final action.
      const tailoredForPages = tailoredData?.tailoredResult || null;
      await autoAdvancePages(tailoredForPages, pendingJob);
      // ─────────────────────────────────────────────────────────────────────────

      // Attempt programmatic resume upload, fall back to download
      try { AALog && AALog.form("ats.resumeUpload.start", {}); } catch(_){}
      const uploaded = await attemptResumeUpload();
      try { AALog && AALog.form("ats.resumeUpload.result", { uploaded }); } catch(_){}
      if (!uploaded) {
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_RESUME",
          job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
        });
      }

      if (isICIMS || isTaleo) {
        const atsName = isICIMS ? "iCIMS" : "Taleo";
        showBanner(
          `${atsName} — basic fields filled. Review everything before submitting.`,
          "user",
          { subtext: uploaded
            ? "Tailored resume uploaded. This ATS may need additional manual input — check all sections."
            : "Check Downloads for your tailored resume PDF. Upload it and complete any remaining fields." }
        );
      } else if (uploaded) {
        // Use "user" (amber/persistent) not "success" so the banner never auto-dismisses
        // while the user still needs to review + submit — and the ⬇ Resume PDF button stays visible.
        showBanner("YOUR TURN — Resume uploaded, fields filled. Review and submit when ready.", "user", { subtext: "Your tailored resume has been uploaded automatically." });
      } else {
        showBanner("YOUR TURN — Fields filled. Download your resume PDF and upload it, then submit.", "user", { subtext: "Click ⬇ Resume PDF to download your tailored resume, then drag it into the upload field." });
      }
      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Generic ATS error", err);
      try { AALog && AALog.error("ats.generic.exception", { message: err.message, stack: err.stack }); } catch(_){}
      showBanner("Hit a snag — filled what we could with your basic profile.", "error", { subtext: "Check the form and fill in any missing fields before submitting." });
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
   * Fill basic profile fields inside a specific document root (main doc or iframe doc).
   * Returns the number of fields successfully filled.
   * This is the synchronous, document-scoped core of fillBasicProfile().
   */
  function fillBasicProfileInDoc(user, doc = document) {
    let filled = 0;

    // Try combined name field first
    let filledFullName = false;
    if (user.firstName && user.lastName) {
      const fullName = `${user.firstName} ${user.lastName}`;
      if (fillByLabel(["full name", "your name", "first & last name", "first and last name"], fullName, doc)) {
        filledFullName = true;
        filled++;
      }
    }

    // Only fill separate first/last if combined didn't work
    if (!filledFullName) {
      if (user.firstName && fillByLabel(["first name", "given name", "prénom"], user.firstName, doc)) filled++;
      if (user.lastName && fillByLabel(["last name", "family name", "surname", "nom"], user.lastName, doc)) filled++;
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
      if (fillByLabel(mapping.labels, mapping.value, doc)) filled++;
    }

    // Fill native <select> Yes/No dropdowns (work auth, residency, sponsorship)
    filled += fillYesNoDropdowns(user, doc);

    // Notice period — always fill on the basic path too
    if (fillByLabel(["notice period", "required notice", "notice period required", "required notice period"], user.noticePeriod || "2 weeks", doc)) filled++;

    return filled;
  }

  /**
   * Fill just the basic profile fields (no tailored data needed).
   * Tries the main document, same-origin iframes, and shadow DOM.
   * Returns total fields filled.
   */
  async function fillBasicProfile() {
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};

    if (!user.firstName && !user.email) {
      showBanner("No profile found — open the extension and fill in your Profile tab first.", "error");
      return 0;
    }

    let filled = 0;

    // Try all accessible document roots (main doc + same-origin iframes)
    const docs = getAccessibleDocuments();
    for (const doc of docs) {
      const docFilled = fillBasicProfileInDoc(user, doc);
      filled += docFilled;
      if (docFilled > 0) {
        console.log(`AutoApply: Filled ${docFilled} fields in ${doc === document ? "main frame" : "iframe"}`);
      }
    }

    if (filled === 0) {
      // Log diagnostics to help identify the root cause
      const inputCount = queryAllDeep('input:not([type="hidden"])').length;
      const labelCount = queryAllDeep("label").length;
      const editableCount = queryAllDeep('[contenteditable], [role="textbox"]').length;
      const iframeCount = document.querySelectorAll("iframe").length;
      console.warn(`AutoApply: 0 fields filled. DOM: ${inputCount} inputs, ${labelCount} labels, ${editableCount} editables, ${iframeCount} iframes`);
      // Log accessible docs
      console.warn(`AutoApply: Accessible docs: ${docs.length} (${iframeCount} iframes total, some may be cross-origin)`);
      // Log iframe sources
      document.querySelectorAll("iframe").forEach((fr, i) => {
        try {
          const accessible = !!(fr.contentDocument);
          console.warn(`AutoApply: iframe[${i}] src="${fr.src}" accessible=${accessible}`);
        } catch (e) {
          console.warn(`AutoApply: iframe[${i}] src="${fr.src}" cross-origin (not accessible)`);
        }
      });
      console.warn("AutoApply: body HTML snippet:", document.body.innerHTML.substring(0, 3000));
    }

    if (filled > 0) {
      showBanner(`Filled ${filled} fields — check any remaining fields and submit when ready.`, "user");
    }
    return filled;
  }

  /**
   * Auto-advance through multi-page ATS forms.
   * After the first page is filled, detect a "Next / Continue" button and click it.
   * Re-fill each subsequent page, stop when we reach the final Submit page or run out of Next buttons.
   * Never clicks Submit — user stays in control.
   */
  async function autoAdvancePages(tailoredResult, pendingJob, maxPages = 8) {
    const NEXT_TEXTS  = ["next", "continue", "next step", "next page", "proceed", "save and continue", "save & continue", "next section"];
    const FINAL_TEXTS = ["submit", "send application", "submit application", "complete application", "finish", "review and submit"];

    for (let page = 1; page <= maxPages; page++) {
      await sleep(800);

      // Find all visible buttons
      const allBtns = Array.from(queryAllDeep("button, [role='button'], input[type='submit'], input[type='button'], a[role='button']"));
      const visible  = allBtns.filter(b => b.offsetParent !== null && b.offsetWidth > 0);

      // Check if final Submit button is present — stop before clicking it
      const hasFinal = visible.some(b => {
        const t = (b.textContent || b.value || "").trim().toLowerCase();
        return FINAL_TEXTS.some(f => t === f || t.includes(f));
      });
      if (hasFinal) {
        console.log(`AutoApply: Multi-page — reached final Submit page after ${page} page(s)`);
        try { AALog && AALog.form("ats.multiPage.finalPage", { page }); } catch(_){}
        return; // Stop — user submits manually
      }

      // Find a Next/Continue button
      const nextBtn = visible.find(b => {
        const t = (b.textContent || b.value || b.getAttribute("aria-label") || "").trim().toLowerCase();
        return NEXT_TEXTS.some(n => t === n || t.startsWith(n));
      });
      if (!nextBtn) {
        console.log(`AutoApply: Multi-page — no Next button on page ${page}, stopping`);
        return; // No more pages
      }

      console.log(`AutoApply: Multi-page — clicking Next on page ${page}: "${(nextBtn.textContent || "").trim().slice(0, 40)}"`);
      try { AALog && AALog.form("ats.multiPage.nextClick", { page, btnText: (nextBtn.textContent || "").trim().slice(0, 40) }); } catch(_){}
      showBanner(`Advancing to next section (page ${page + 1})...`, "ai", { subtext: "Filling your details..." });
      nextBtn.click();

      // Wait for next page to render
      await sleep(2000);

      // Re-fill the new page
      try {
        await fillBasicProfile();
        if (tailoredResult) await fillGenericForm(tailoredResult, pendingJob);
        try { AALog && AALog.form("ats.multiPage.pageFilled", { page: page + 1 }); } catch(_){}
      } catch (fillErr) {
        console.warn(`AutoApply: Multi-page fill error on page ${page + 1}:`, fillErr.message);
      }
    }
    console.log("AutoApply: Multi-page — reached max page limit");
  }

  /** Normalise a degree string from a resume to the standard label used in most ATS dropdowns */
  function normalizeDegree(raw) {
    const d = (raw || "").toLowerCase();
    if (d.includes("phd") || d.includes("doctor")) return "Doctorate";
    if (d.includes("mba") || d.includes("master")) return "Master's";
    if (d.includes("bachelor") || d.includes("b.sc") || d.includes("b.a") || d.includes("b.eng") || d.includes("b.com") || /\b(ba|bs|be|bcom|bba|bsc)\b/.test(d)) return "Bachelor's";
    if (d.includes("associate")) return "Associate's";
    if (d.includes("diploma")) return "Diploma";
    if (d.includes("certificate")) return "Certificate";
    return raw;
  }

  /** Derive yyyy-mm-dd start/end dates from an education year field ("2022" or "2020–2022") */
  function eduDates(year) {
    const rangeMatch = String(year || "").match(/(\d{4})\s*[-–—]\s*(\d{4})/);
    if (rangeMatch) return { start: `${rangeMatch[1]}-09-01`, end: `${rangeMatch[2]}-05-01` };
    const single = String(year || "").match(/(\d{4})/);
    if (single) {
      const y = parseInt(single[1]);
      return { start: `${y - 2}-09-01`, end: `${y}-05-01` };
    }
    return { start: "", end: "" };
  }

  async function fillGenericForm(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile", "parsedResume"]);
    const user = profile.userProfile || {};
    const edu = (profile.parsedResume?.education || [])[0] || {};

    console.log("AutoApply: User profile:", JSON.stringify(user));

    const docs = getAccessibleDocuments();
    let filled = 0;

    for (const doc of docs) {
      // Try combined name field first
      let filledFullName = false;
      if (user.firstName && user.lastName) {
        const fullName = `${user.firstName} ${user.lastName}`;
        if (fillByLabel(["full name", "your name", "first & last name", "first and last name"], fullName, doc)) {
          filledFullName = true;
          filled++;
        }
      }

      // Separate first/last name if combined didn't work
      if (!filledFullName) {
        const nameFieldMappings = [
          { labels: ["first name", "given name", "prénom"], value: user.firstName },
          { labels: ["last name", "family name", "surname", "nom"], value: user.lastName },
        ];
        for (const mapping of nameFieldMappings) {
          if (!mapping.value) continue;
          if (fillByLabel(mapping.labels, mapping.value, doc)) filled++;
        }
      }

      // Try JD text first, then fall back to scraping salary from the current page
      // (ATS pages often show salary ranges in a sidebar even if the stored JD didn't include it)
      let maxPay = extractMaxPayFromJD(job?.jobDescription || "");
      if (!maxPay) {
        const pageText = document.body?.innerText || "";
        maxPay = extractMaxPayFromJD(pageText);
      }

      const fieldMappings = [
        { labels: ["email", "e-mail", "email address"], value: user.email },
        { labels: ["phone", "telephone", "mobile", "phone number"], value: user.phone },
        { labels: ["linkedin", "linkedin url", "linkedin profile"], value: user.linkedin },
        { labels: ["github", "github url", "github profile"], value: user.github },
        { labels: ["portfolio", "website", "personal website", "portfolio url", "website url"], value: user.portfolio || user.website },
        { labels: ["preferred name", "nickname", "what should we call you"], value: user.preferredName },
        { labels: ["pronoun", "pronouns", "preferred pronoun"], value: user.pronouns },
        { labels: ["city", "location", "address", "city, province", "city, state"], value: user.province ? `Vancouver, ${user.province}, Canada` : "" },
        { labels: ["current company", "current employer", "company name", "current organization", "employer"], value: user.currentCompany },
        { labels: ["how did you hear", "how did you find", "where did you hear", "referral source"], value: user.howDidYouHear },
        // Salary expectation — fill with max pay from JD, fallback to profile value
        { labels: ["salary", "compensation", "salary expectation", "minimum salary", "base salary", "minimum base salary", "salary expectations", "minimum base", "expected salary", "desired salary", "pay expectation"], value: maxPay || user.salaryExpectation || user.compensation },
        // Notice period
        { labels: ["notice period", "required notice", "notice period required", "required notice period"], value: user.noticePeriod || "2 weeks" },
        // [AutoQA fix 2026-04-08] "Years of experience" text/number inputs were not handled
        // in fillGenericForm's fieldMappings, causing them to be left blank on many ATS forms.
        // These are plain input fields (not radio buttons) that expect a numeric answer.
        { labels: ["years of experience", "years of relevant experience", "years of work experience", "total years of experience", "years of professional experience"], value: user.yearsOfExperience || "" },
      ];

      for (const mapping of fieldMappings) {
        if (!mapping.value) continue;
        if (fillByLabel(mapping.labels, mapping.value, doc)) filled++;
      }

      // Province/territory dropdown — try select element first, then text input
      const provinceValue = user.province || "British Columbia";
      if (fillSelectByLabel(["province", "territory", "province or territory", "state or province", "province/territory", "located in"], provinceValue, doc)) {
        filled++;
      }

      // Native <select> Yes/No dropdowns (work auth, residency, sponsorship) — Breezy HR etc.
      filled += fillYesNoDropdowns(user, doc);

      // ── Education fields ──────────────────────────────────────────────────────
      if (edu.school) {
        if (fillByLabel(["school", "institution", "university", "college", "school name"], edu.school, doc)) filled++;
      }
      if (edu.degree) {
        const degreeNorm = normalizeDegree(edu.degree);
        // Degree is usually a <select> dropdown; fall back to text input
        if (fillSelectByLabel(["degree", "highest level of education", "level of education", "education level", "degree level"], degreeNorm, doc)) {
          filled++;
        } else if (fillByLabel(["degree", "degree type", "degree level", "field of study"], degreeNorm, doc)) {
          filled++;
        }
      }
      if (edu.year) {
        const { start: eduStart, end: eduEnd } = eduDates(edu.year);
        if (eduStart && fillByLabel(["start date", "start year", "from date", "date from", "education start"], eduStart, doc)) filled++;
        if (eduEnd   && fillByLabel(["end date", "end year", "graduation date", "to date", "date to", "education end", "completion date", "expected graduation"], eduEnd, doc)) filled++;
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Button-style Yes/No questions (Ashby uses toggle buttons, not radio inputs)
      const btnFilled = await fillButtonStyleYesNo(doc);
      filled += btnFilled;

      // Fill cover letter in large textareas
      if (tailoredResult.coverLetter) {
        const textareas = queryAllDeep("textarea", doc);
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
    }

    // ── Custom question pass: fill any remaining unfilled textareas ──────────
    // After standard profile/tailored fields, scan for unanswered open-ended
    // questions (e.g. "Describe how you use AI tools in your work") and ask
    // the backend to generate a targeted answer.
    try {
      const customFilled = await fillCustomQuestions(tailoredResult, job);
      filled += customFilled;
    } catch (cqErr) {
      console.warn("AutoApply: Custom question fill failed:", cqErr.message);
    }

    console.log(`AutoApply: Filled ${filled} fields total`);
    return filled;
  }

  /**
   * Detect unfilled textarea / contenteditable fields that look like open-ended
   * custom questions (label text ≥ 20 chars), ask the backend to answer each
   * one, and fill the answers.
   */
  async function fillCustomQuestions(tailoredResult, job) {
    // Collect all textareas across accessible documents
    const docs = getAccessibleDocuments();
    const candidates = [];

    for (const doc of docs) {
      const textareas = queryAllDeep("textarea", doc);
      for (const ta of textareas) {
        if ((ta.value || "").trim()) continue; // already filled
        const rawLabel = getFieldLabel(ta);
        const label = rawLabel.toLowerCase();

        // Skip known standard fields already handled above
        const standardPrefixes = ["cover", "letter", "additional", "message", "comments", "note",
          "email", "phone", "linkedin", "github", "portfolio", "name", "city", "location"];
        if (standardPrefixes.some(p => label.includes(p))) continue;

        // Only pick up labels that look like open-ended questions (≥ 20 chars)
        if (rawLabel.length >= 20) {
          candidates.push({ element: ta, label: rawLabel });
        }
      }
    }

    if (candidates.length === 0) return 0;

    // Get the user's resume summary for context
    const profile = await chrome.storage.local.get(["userProfile"]);
    const user = profile.userProfile || {};
    const resumeSummary = tailoredResult?.tailoredResume?.summary ||
                          user.resumeSummary || "";

    let filled = 0;
    for (const { element, label } of candidates) {
      try {
        const resp = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 12000);
          chrome.runtime.sendMessage(
            {
              type: "ANSWER_CUSTOM_QUESTION",
              question: label,
              resumeSummary,
              jobTitle: job?.jobTitle || "",
              company: job?.company || "",
            },
            (r) => { clearTimeout(timer); resolve(r); }
          );
        });

        const answer = resp?.answer;
        if (answer && answer.length > 10) {
          setNativeValue(element, answer);
          console.log(`AutoApply: Filled custom question "${label.slice(0, 60)}" with AI answer`);
          try { AALog && AALog.form("ats.fillCustomQuestion.done", { labelPreview: label.slice(0, 80), answerLen: answer.length }); } catch(_){}
          filled++;
        }
      } catch (e) {
        console.warn(`AutoApply: Failed to answer custom question "${label.slice(0, 40)}":`, e.message);
      }
    }

    return filled;
  }

  /**
   * Set a form input value in a way that works with React, Vue, Angular, etc.
   * React overrides the native .value setter, so we need to use the native one
   * and dispatch proper events.
   */
  function setNativeValue(element, value) {
    // SELECT elements don't use the HTMLInputElement prototype setter — doing so
    // throws "Illegal invocation". Just set .value directly and fire change.
    if (element.tagName === "SELECT") {
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    // Use the element's own window to get the correct native value setter.
    // Avoids cross-frame "Illegal invocation" when elements come from iframes.
    const ownerWin = element.ownerDocument?.defaultView || window;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      ownerWin.HTMLInputElement.prototype, "value"
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      ownerWin.HTMLTextAreaElement.prototype, "value"
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
    // Extra: InputEvent for date/number inputs in newer React forms
    if (element.type === "date" || element.type === "number" || element.type === "month") {
      try {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      } catch (_) {}
    }
  }

  /**
   * Fill a form field identified by label text with the given value.
   * Accepts an optional `doc` parameter to search inside a specific document root
   * (e.g. an iframe's contentDocument). Defaults to the main document.
   *
   * Uses four strategies in order:
   *   1. <label> element match (with 'for' attribute or DOM proximity)
   *   2. Input attribute match (placeholder, name, id, aria-label)
   *   3. Nearby visible text match (React-style forms without <label>)
   *   4. aria-placeholder / contenteditable (Ashby, Draft.js, rich-text)
   *
   * All strategies also search inside open shadow roots via queryAllDeep().
   */
  function fillByLabel(labelTexts, value, doc = document) {
    if (!value) return false;

    // Strategy 1: match <label> elements (including inside shadow DOM)
    const labels = queryAllDeep("label", doc);
    for (const label of labels) {
      const labelText = (label.textContent || "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      if (labelTexts.some((t) => labelText.includes(t) || labelText === t)) {
        const forId = label.getAttribute("for");
        let input = forId ? (doc.getElementById ? doc.getElementById(forId) : null) : null;

        // If no for attribute, search nearby
        if (!input) {
          const container = label.closest("div, fieldset, li, section");
          input = container?.querySelector("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea, select");
          // Also check shadow DOM inside the container
          if (!input && container) {
            input = queryDeep("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea, select", container);
          }
        }

        // Try next sibling
        if (!input) {
          let sibling = label.nextElementSibling;
          if (sibling?.tagName === "DIV") {
            input = sibling.querySelector("input, textarea") || queryDeep("input, textarea", sibling);
          } else if (sibling?.tagName === "INPUT" || sibling?.tagName === "TEXTAREA") {
            input = sibling;
          }
        }

        if (input) {
          console.log(`AutoApply: Filling "${labelText}" with "${value.substring(0, 20)}..."`);
          setNativeValue(input, value);
          return true;
        }

        // Check for contenteditable/textbox near the label
        const container2 = label.closest("div, fieldset, li, section");
        if (container2) {
          const editable = container2.querySelector('[contenteditable="true"], [contenteditable=""], [role="textbox"]') ||
                           queryDeep('[contenteditable="true"], [contenteditable=""], [role="textbox"]', container2);
          if (editable && !editable.textContent.trim()) {
            console.log(`AutoApply: Filling editable near label "${labelText}" with "${value.substring(0, 20)}..."`);
            setEditableValue(editable, value);
            return true;
          }
        }
      }
    }

    // Strategy 2: match by placeholder, name, id, or aria-label (including shadow DOM)
    // Normalise underscores → spaces so "education_start_date" matches "start date"
    const inputs = queryAllDeep(
      "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea",
      doc
    );
    for (const input of inputs) {
      const placeholder = (input.placeholder || "").toLowerCase();
      const name = (input.name || "").toLowerCase().replace(/_/g, " ");
      const id = (input.id || "").toLowerCase().replace(/_/g, " ");
      const ariaLabel = (input.getAttribute("aria-label") || "").toLowerCase();

      if (labelTexts.some((t) =>
        placeholder.includes(t) || name.includes(t) || id.includes(t) || ariaLabel.includes(t)
      )) {
        if (!input.value) {
          console.log(`AutoApply: Filling input (${input.name || input.id || placeholder}) with "${value.substring(0, 20)}..."`);
          setNativeValue(input, value);
          return true;
        }
      }
    }

    // Strategy 3: match by visible text near input (React-style forms without <label>)
    const allTexts = queryAllDeep("span, p, div, h3, h4, h5, h6, strong, b", doc);
    for (const textEl of allTexts) {
      const text = (textEl.textContent || "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text.length > 60) continue;
      if (!labelTexts.some((t) => text === t || text.includes(t))) continue;

      const parent = textEl.closest("div, fieldset, section, li");
      if (!parent) continue;

      // Standard input
      const input = parent.querySelector(
        "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea"
      ) || queryDeep("input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea", parent);
      if (input && !input.value) {
        console.log(`AutoApply: Filling near text "${text}" with "${value.substring(0, 20)}..."`);
        setNativeValue(input, value);
        return true;
      }

      // Contenteditable or role=textbox (Ashby, Draft.js, etc.)
      const editable = parent.querySelector('[contenteditable="true"], [contenteditable=""], [role="textbox"]') ||
                       queryDeep('[contenteditable="true"], [contenteditable=""], [role="textbox"]', parent);
      if (editable && !editable.textContent.trim()) {
        console.log(`AutoApply: Filling contenteditable near "${text}" with "${value.substring(0, 20)}..."`);
        setEditableValue(editable, value);
        return true;
      }
    }

    // Strategy 4: aria-placeholder attribute (Ashby accessible inputs)
    const ariaPlaceholders = queryAllDeep('[aria-placeholder], [placeholder]', doc);
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
    // [AutoQA fix 2026-04-09] Use element.ownerDocument.execCommand() instead of
    // the top-level document.execCommand(). When element lives inside a same-origin
    // iframe (returned by getAccessibleDocuments()), document refers to the main
    // frame's document — execCommand("selectAll") selects the wrong document and
    // execCommand("insertText") inserts there instead of in the focused iframe element.
    const ownerDoc = element.ownerDocument || document;
    ownerDoc.execCommand("selectAll", false, null);
    ownerDoc.execCommand("insertText", false, value);
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

    // Find file input across all accessible docs (including iframes + shadow DOM)
    let fileInput = null;
    const docs = getAccessibleDocuments();
    for (const doc of docs) {
      fileInput = queryDeep('input[type="file"][name*="resume"], input[type="file"][name*="cv"]', doc);
      if (fileInput) break;
      const fileInputs = queryAllDeep('input[type="file"]', doc);
      for (const fi of fileInputs) {
        const label = getFieldLabel(fi).toLowerCase();
        if (label.includes("resume") || label.includes("cv") || label.includes("upload")) {
          fileInput = fi;
          break;
        }
      }
      if (fileInput) break;
      // Fall back to first file input in this doc
      const allFiles = queryAllDeep('input[type="file"]', doc);
      if (allFiles.length > 0) { fileInput = allFiles[0]; break; }
    }

    if (!fileInput) {
      console.log("AutoApply: No file input found for resume upload");
      try { AALog && AALog.error("ats.resumeUpload.noInput", {
        totalFileInputs: document.querySelectorAll('input[type="file"]').length,
        url: location.href,
      }); } catch(_){}
      return false;
    }

    const inputLabel = getFieldLabel(fileInput).slice(0, 80);
    const inputName  = (fileInput.name || fileInput.id || "").slice(0, 60);
    try { AALog && AALog.form("ats.resumeUpload.inputFound", { label: inputLabel, name: inputName }); } catch(_){}

    // ── Strategy 0 (PRIMARY): Run upload in MAIN world via background ──────────
    // Content scripts run in an isolated world where React's __reactProps$
    // expando properties (set by the page's main world) are NOT visible.
    // By delegating to chrome.scripting.executeScript({world:"MAIN"}), the
    // background can call React's onChange handler directly.
    try {
      const mainWorldResult = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ success: false, error: "timeout" }), 8000);
        chrome.runtime.sendMessage(
          { type: "UPLOAD_RESUME_MAIN_WORLD", base64Pdf: stored.tailoredResumePdf, filename: "Resume.pdf" },
          (resp) => { clearTimeout(timer); resolve(resp || { success: false, error: "no response" }); }
        );
      });

      if (mainWorldResult?.success) {
        // Wait for React to process the change and verify via DOM.
        // Some ATSs (Ashby) render the filename in a completely different
        // part of the DOM than where the file input lives, so we check
        // the whole document body rather than just uploadRoot.
        await new Promise(r => setTimeout(r, 1800));
        const uploadRoot = fileInput.closest('[role="presentation"], [class*="upload"], [class*="dropzone"], section') ||
                           fileInput.parentElement?.parentElement;
        const confirmed = (
          // Narrow: check the upload container for state/filename
          (uploadRoot && (
            (uploadRoot.getAttribute("data-state") && uploadRoot.getAttribute("data-state") !== "default") ||
            uploadRoot.textContent.includes("Resume.pdf") ||
            uploadRoot.querySelector('[class*="filename"], [class*="file-name"], [class*="name"]')
          )) ||
          // Wide: Ashby and similar ATSs render filename anywhere in the document
          document.body.textContent.includes("Resume.pdf") ||
          !!document.querySelector('[class*="filename"], [class*="file-name"]')
        );
        if (confirmed) {
          console.log(`AutoApply: Resume uploaded via main-world (strategy: ${mainWorldResult.strategy})`);
          try { AALog && AALog.form("ats.resumeUpload.result", { success: true, strategy: mainWorldResult.strategy, label: inputLabel, verified: true }); } catch(_){}
          return true;
        }
        console.log(`AutoApply: Main-world upload ran (${mainWorldResult.strategy}) but DOM confirmation not found — falling back to download`);
        try { AALog && AALog.form("ats.resumeUpload.result", { success: false, strategy: mainWorldResult.strategy + "-unconfirmed", label: inputLabel }); } catch(_){}
        return false;
      }
      console.log(`AutoApply: Main-world upload returned failure: ${mainWorldResult?.error}`);
    } catch (stratErr) {
      console.log(`AutoApply: Main-world strategy threw: ${stratErr.message}`);
    }

    // ── Strategy 1 (FALLBACK): React onChange from isolated world ───────────────
    // May not find __reactProps$ from isolated world, but try anyway in case
    // the browser version or React version makes it visible.
    try {
      const binaryStr = atob(stored.tailoredResumePdf);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const file = new File([blob], "Resume.pdf", { type: "application/pdf" });

      const reactPropsKey = Object.keys(fileInput).find(k => k.startsWith("__reactProps$"));
      if (reactPropsKey && fileInput[reactPropsKey]?.onChange) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput[reactPropsKey].onChange({
          target: { files: dt.files },
          currentTarget: { files: dt.files },
          preventDefault: () => {},
          stopPropagation: () => {},
          persist: () => {},
          nativeEvent: new Event("change"),
          type: "change",
          bubbles: true,
        });
        console.log("AutoApply: Resume uploaded via React onChange (isolated world)");
        try { AALog && AALog.form("ats.resumeUpload.result", { success: true, strategy: "react-onChange-isolated", label: inputLabel }); } catch(_){}
        return true;
      }
    } catch (s1Err) {
      console.log(`AutoApply: Strategy 1 threw: ${s1Err.message}`);
    }

    console.log("AutoApply: All upload strategies failed — falling back to download");
    try { AALog && AALog.error("ats.resumeUpload.allFailed", { label: inputLabel }); } catch(_){}
    return false;
  }

  function getFieldLabel(element) {
    const id = element.id;
    if (id) {
      const ownerDoc = element.ownerDocument || document;
      const label = ownerDoc.querySelector(`label[for="${id}"]`);
      if (label) return label.textContent?.trim() || "";
    }
    // Walk up to 6 ancestors looking for a label-like element.
    // Checks label, then h3/h4/p/strong for ATS systems (Breezy HR) that use
    // heading elements instead of <label> to caption their custom questions.
    let node = element.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!node) break;
      const lbl = node.querySelector("label");
      if (lbl) return lbl.textContent?.trim() || "";
      // Breezy HR pattern: question text is in an <h3> sibling of dropdown-container
      const heading = node.querySelector("h3, h4, h5, p, strong");
      if (heading) {
        const text = heading.textContent?.trim() || "";
        // Sanity: must look like a question/label (< 200 chars, not a block of options text)
        if (text && text.length < 200) return text;
      }
      // Stop traversing once we hit a known question-wrapper boundary
      if (node.matches?.("li, fieldset, form, section")) break;
      node = node.parentElement;
    }
    return element.getAttribute("aria-label") || element.placeholder || "";
  }

  /**
   * Extract the maximum dollar amount from a job description string.
   * Used to fill compensation/salary expectation fields.
   */
  function extractMaxPayFromJD(jdText) {
    if (!jdText) return "";
    const matches = [];
    // Handles: $160K, CA$160K, CA$ 160,000, $160,000, $160k
    const regex = /(?:CA|US|C|USD?)?\$\s*([\d,]+(?:\.\d+)?)\s*([kK])?/g;
    let m;
    while ((m = regex.exec(jdText)) !== null) {
      let val = parseFloat(m[1].replace(/,/g, ""));
      if (m[2]) val *= 1000;
      // Sanity-filter: only accept realistic salary values ($30K–$2M)
      if (val >= 30000 && val <= 2000000) matches.push(val);
    }
    if (matches.length === 0) return "";
    const maxVal = Math.max(...matches);
    // Format nicely: if over 1000, show as e.g. "300000" for text input
    return String(Math.round(maxVal));
  }

  /** Formatted pay range for banner display, e.g. "$120K–$190K". */
  function extractPayRangeFromJD(jdText) {
    if (!jdText) return null;
    const amounts = [];
    const re = /(?:CA|US|C|USD?)?\$\s*([\d,]+(?:\.\d+)?)\s*([kK])?/g;
    let m;
    while ((m = re.exec(jdText)) !== null) {
      let val = parseFloat(m[1].replace(/,/g, ""));
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

  // ── Fill native <select> Yes/No dropdowns (work auth, residency, sponsorship) ──
  function fillYesNoDropdowns(user, doc = document) {
    let filled = 0;
    const selects = queryAllDeep("select", doc);
    for (const sel of selects) {
      const label = getFieldLabel(sel).toLowerCase();
      // Work authorization → Yes
      if (/legal(ly)?\s*(authorized|eligible|allowed|entitled)\s*to\s*work|right\s*to\s*work|work\s*auth/i.test(label)) {
        if (fillSelectElement(sel, "yes")) filled++;
      }
      // Residency — match province from user profile
      else if (/reside|residing|resident|live\s*in|living\s*in|based\s*in|located\s*in/i.test(label)) {
        const userProv = (user.province || "").toLowerCase();
        const inBC = userProv.includes("british columbia") || userProv === "bc";
        const inON = userProv.includes("ontario") || userProv === "on";
        const labelHasBC = /british columbia|b\.?c\.?/i.test(label);
        const labelHasON = /ontario|\bon\b/i.test(label);
        if      (labelHasBC) { if (fillSelectElement(sel, inBC ? "yes" : "no")) filled++; }
        else if (labelHasON) { if (fillSelectElement(sel, inON ? "yes" : "no")) filled++; }
        else                 { if (fillSelectElement(sel, "yes")) filled++; }
      }
      // Visa sponsorship → No
      else if (/sponsor|sponsorship|visa\s*support|immigration/i.test(label)) {
        if (fillSelectElement(sel, "no")) filled++;
      }
      // Criminal record → No
      else if (/criminal|convicted|felony|misdemeanor/i.test(label)) {
        if (fillSelectElement(sel, "no")) filled++;
      }
    }
    return filled;
  }

  // Pick the first <option> whose visible text contains targetText
  function fillSelectElement(sel, targetText) {
    const target = targetText.toLowerCase();
    for (const opt of sel.options) {
      if (!opt.value || opt.disabled) continue;
      if (opt.text.toLowerCase().includes(target)) {
        if (sel.value === opt.value) return false; // already correct
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sel.dispatchEvent(new Event("input",  { bubbles: true }));
        console.log(`AutoApply: Dropdown "${getFieldLabel(sel)}" → "${opt.text}"`);
        return true;
      }
    }
    return false;
  }

  /**
   * Fill a <select> dropdown by finding its label, then selecting the matching option.
   * Returns true if a match was found and selected.
   */
  function fillSelectByLabel(labelTexts, value, doc = document) {
    if (!value) return false;
    const valueLower = value.toLowerCase();

    // Find all <select> elements and check their associated label
    const selects = queryAllDeep("select", doc);
    for (const sel of selects) {
      const rawLabel = getFieldLabel(sel).toLowerCase();
      const labelText = rawLabel.replace(/_/g, " ");
      const matchesLabel = labelTexts.some(t => labelText.includes(t));
      if (!matchesLabel) {
        // Also check nearby text nodes and element name/id
        const selName = (sel.name || sel.id || "").toLowerCase().replace(/_/g, " ");
        if (labelTexts.some(t => selName.includes(t))) { /* matched by name/id — fall through */ }
        else {
          const container = sel.closest("div, fieldset, section, li");
          if (container) {
            const nearbyText = (container.querySelector("label, p, span, div")?.textContent || "").toLowerCase().replace(/_/g, " ");
            if (!labelTexts.some(t => nearbyText.includes(t))) continue;
          } else continue;
        }
      }

      // Try to find matching option (by text or value)
      const options = Array.from(sel.options);
      let matchedOption = options.find(o =>
        o.text.toLowerCase() === valueLower ||
        o.value.toLowerCase() === valueLower
      );
      // Partial match fallback
      if (!matchedOption) {
        matchedOption = options.find(o =>
          o.text.toLowerCase().includes(valueLower) ||
          valueLower.includes(o.text.toLowerCase().replace(/\s+/g, ""))
        );
      }
      // Province abbreviation matching (e.g. "BC" → "British Columbia")
      if (!matchedOption) {
        const abbrevMap = {
          "bc": "british columbia", "ab": "alberta", "on": "ontario",
          "qc": "quebec", "mb": "manitoba", "sk": "saskatchewan",
          "ns": "nova scotia", "nb": "new brunswick", "nl": "newfoundland",
          "pe": "prince edward island", "nt": "northwest territories",
          "yt": "yukon", "nu": "nunavut",
        };
        const expanded = abbrevMap[valueLower] || valueLower;
        matchedOption = options.find(o => o.text.toLowerCase().includes(expanded) || expanded.includes(o.text.toLowerCase()));
      }

      if (matchedOption) {
        sel.value = matchedOption.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        console.log(`AutoApply: Selected "${matchedOption.text}" in province/territory dropdown`);
        return true;
      }
    }
    return false;
  }

  /**
   * Fill button-style Yes/No questions (Ashby renders these as <button> toggles,
   * not native radio inputs — so fillByLabel() misses them entirely).
   *
   * Rules:
   *  - Criminal record / conviction → "No"
   *  - Work eligibility in Canada → "Yes"
   *  - Visa / immigration sponsorship → "No"
   *
   * Returns the count of buttons clicked.
   */
  async function fillButtonStyleYesNo(doc = document) {
    const rules = [
      {
        keywords: ["convicted", "criminal", "charges", "offense", "offence", "felony", "misdemeanor", "criminal record"],
        answer: "no",
        label: "criminal record",
      },
      {
        // "Are you legally allowed to work in Canada or the US?" — options: Canada / USA / Neither
        // Click "Canada" first; if no "Canada" button found, fall back to "Yes"
        keywords: ["legally eligible to work", "eligible to work in canada", "authorized to work in canada", "right to work in canada", "legally allowed to work"],
        answer: "canada",
        answerFallback: "yes",
        label: "work eligibility",
      },
      {
        keywords: ["require.*sponsorship", "need.*sponsorship", "visa sponsorship", "immigration sponsorship", "work authorization sponsorship"],
        answer: "no",
        label: "visa sponsorship",
        useRegex: true,
      },
      {
        keywords: ["are you based in", "located in", "open to relocating", "commute", "in the office", "onsite", "on-site", "in person"],
        answer: "yes",
        label: "office/location",
      },
    ];

    let clicked = 0;

    // Walk all potential question-containers in the document
    const allEls = queryAllDeep("label, legend, p, div, span, h3, h4, h5", doc);

    for (const el of allEls) {
      // Skip elements that are themselves buttons or inside buttons
      if (el.closest("button, [role='button']")) continue;
      // Skip elements with too many direct children (layout containers)
      if (el.children.length > 6) continue;

      const questionText = (el.textContent || "").trim().toLowerCase();
      if (questionText.length < 8 || questionText.length > 400) continue;

      // Find matching rule
      // [Fix 2026-04-08] Track matchedRule separately — `rule` is block-scoped to the
      // for…of loop and is undefined after the loop exits (even after a `break`). Accessing
      // rule.answerFallback outside the loop was the source of 8 "rule is not defined"
      // ReferenceErrors observed during QA.
      let matchedAnswer = null;
      let matchedRule = null;
      for (const rule of rules) {
        let matched = false;
        if (rule.useRegex) {
          matched = rule.keywords.some(kw => new RegExp(kw, "i").test(questionText));
        } else {
          matched = rule.keywords.some(kw => questionText.includes(kw));
        }
        if (matched) { matchedAnswer = rule.answer; matchedRule = rule; break; }
      }
      if (!matchedAnswer) continue;

      // Look for answer buttons in the nearest enclosing container
      const container = el.closest("div, fieldset, section, li, form") || el.parentElement;
      if (!container) continue;

      // The target answer text(s) to look for — supports specific text (e.g. "canada") or yes/no
      const targetAnswers = [matchedAnswer];
      if (matchedRule?.answerFallback) targetAnswers.push(matchedRule.answerFallback);

      function answerMatches(rawText, targets) {
        const t = rawText.trim().toLowerCase();
        return targets.some(ans => {
          if (ans === "yes") return t === "yes" || t.startsWith("yes");
          if (ans === "no")  return t === "no"  || t.startsWith("no");
          return t === ans || t.startsWith(ans); // specific text match e.g. "canada"
        });
      }

      function isAlreadySelected(btn) {
        return btn.classList.contains("selected") ||
               btn.classList.contains("active") ||
               btn.getAttribute("aria-selected") === "true" ||
               btn.getAttribute("aria-pressed") === "true" ||
               btn.getAttribute("aria-checked") === "true" ||
               (btn.type === "radio"    && btn.checked) ||
               (btn.type === "checkbox" && btn.checked);
      }

      // Find button/radio/checkbox candidates — includes input[type="checkbox"]
      const btnSelector = 'button, [role="radio"], [role="option"], [role="button"], label input[type="radio"], label input[type="checkbox"], input[type="radio"], input[type="checkbox"]';
      const btnCandidates = Array.from(container.querySelectorAll(btnSelector));
      const shadowBtns    = queryAllDeep('button, [role="radio"], [role="option"]', container);
      const allBtns = [...new Set([...btnCandidates, ...shadowBtns])];

      // For checkboxes/radio inside <label>, use the label text; otherwise button own text
      function getBtnText(btn) {
        if ((btn.type === "radio" || btn.type === "checkbox") && btn.closest("label")) {
          return btn.closest("label").textContent || "";
        }
        return btn.textContent || btn.value || btn.getAttribute("aria-label") || "";
      }

      let foundAndClicked = false;
      for (const btn of allBtns) {
        const rawText = getBtnText(btn);
        if (!answerMatches(rawText, targetAnswers)) continue;

        if (!isAlreadySelected(btn)) {
          console.log(`AutoApply: Clicking "${rawText.trim()}" for question: "${questionText.slice(0, 70)}"`);
          btn.click();
          await sleep(150);
          clicked++;
        } else {
          console.log(`AutoApply: Already selected "${rawText.trim()}" for: "${questionText.slice(0, 70)}"`);
        }
        foundAndClicked = true;
        break;
      }

      // One level up fallback
      if (!foundAndClicked && container.parentElement) {
        const parent = container.parentElement;
        const parentBtns = Array.from(parent.querySelectorAll(btnSelector));
        for (const btn of parentBtns) {
          const rawText = getBtnText(btn);
          if (!answerMatches(rawText, targetAnswers)) continue;
          if (!isAlreadySelected(btn)) {
            console.log(`AutoApply: (parent) Clicking "${rawText.trim()}" for: "${questionText.slice(0, 70)}"`);
            btn.click();
            await sleep(150);
            clicked++;
          }
          break;
        }
      }
    }

    console.log(`AutoApply: fillButtonStyleYesNo clicked ${clicked} buttons`);
    return clicked;
  }

  /**
   * Fill iCIMS-specific form fields using the selector patterns iCIMS uses.
   * iCIMS renders standard HTML inputs but with predictable id/name patterns.
   * Returns the count of fields filled.
   */
  function fillICIMSForm(user) {
    let filled = 0;
    const mappings = [
      { selectors: ['input[id*="firstname" i]', 'input[name*="firstname" i]', 'input[id*="first_name" i]', 'input[name*="first_name" i]'], value: user.firstName },
      { selectors: ['input[id*="lastname" i]', 'input[name*="lastname" i]', 'input[id*="last_name" i]', 'input[name*="last_name" i]'], value: user.lastName },
      { selectors: ['input[id*="email" i]', 'input[name*="email" i]', 'input[type="email"]'], value: user.email },
      { selectors: ['input[id*="phone" i]', 'input[name*="phone" i]', 'input[id*="mobile" i]', 'input[name*="mobile" i]'], value: user.phone },
      { selectors: ['input[id*="address" i]', 'input[name*="address" i]', 'input[id*="street" i]'], value: user.address },
      { selectors: ['input[id*="city" i]', 'input[name*="city" i]'], value: user.city || "Vancouver" },
      { selectors: ['input[id*="postal" i]', 'input[name*="postal" i]', 'input[id*="zip" i]', 'input[name*="zip" i]'], value: user.postalCode },
      { selectors: ['input[id*="linkedin" i]', 'input[name*="linkedin" i]'], value: user.linkedin },
    ];

    for (const { selectors, value } of mappings) {
      if (!value) continue;
      for (const sel of selectors) {
        try {
          const input = document.querySelector(sel);
          if (input && !input.value) {
            setNativeValue(input, value);
            filled++;
            break;
          }
        } catch (_) {}
      }
    }

    console.log(`AutoApply: iCIMS-specific fill: ${filled} fields`);
    return filled;
  }

  /**
   * Fill iCIMS Work History section by clicking "Add Work History" for each
   * entry and filling the resulting fields.
   *
   * iCIMS renders work history as a repeating section. Each entry is created
   * by clicking an "Add" / "Add Work History" button, which shows an inline
   * form (or modal). Fields use predictable id/name patterns:
   *   employer / company / organization → company name
   *   title / jobtitle / job_title       → job title
   *   startdate / start_date / datefrom  → start date (MM/YYYY or MM/DD/YYYY)
   *   enddate   / end_date   / dateto    → end date
   *   current / currentemployer          → "currently work here" checkbox
   *   description / duties / jobdesc     → job description
   *
   * Returns the number of entries filled.
   */
  async function fillICIMSWorkHistory(workExp) {
    if (!workExp || workExp.length === 0) return 0;

    // ── Locate the Work History section ──────────────────────────────────────
    // Find the "Add Work History" / "Add a record" button near a heading that
    // says "Work History" or "Work Experience".
    function findAddWorkHistoryButton() {
      // Strategy 1: button text
      for (const btn of document.querySelectorAll("button, a[role='button'], input[type='button'], input[type='submit']")) {
        const t = (btn.textContent || btn.value || "").trim().toLowerCase();
        if (/add work history/i.test(t) || /add (a )?record/i.test(t) || t === "add") {
          // Only if the button is inside (or near) a "work history" section
          let el = btn;
          for (let d = 0; d < 10 && el && el !== document.body; d++, el = el.parentElement) {
            if ((el.textContent || "").toLowerCase().includes("work history") ||
                (el.textContent || "").toLowerCase().includes("work experience") ||
                (el.textContent || "").toLowerCase().includes("employment")) {
              return btn;
            }
          }
        }
      }
      // Strategy 2: aria-label
      for (const btn of document.querySelectorAll("button[aria-label]")) {
        const a = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (a.includes("add") && (a.includes("work") || a.includes("employment") || a.includes("history"))) {
          return btn;
        }
      }
      return null;
    }

    // ── Find the fields within a just-opened work history entry form ──────────
    function findWHField(patterns) {
      for (const pattern of patterns) {
        const el = document.querySelector(
          `input[id*="${pattern}" i], input[name*="${pattern}" i], ` +
          `textarea[id*="${pattern}" i], textarea[name*="${pattern}" i]`
        );
        if (el && el.offsetParent !== null) return el;
      }
      return null;
    }

    // ── Format a date string (ISO "2020-03" or "2020") to MM/YYYY ────────────
    function fmtDate(d) {
      if (!d) return "";
      const m = String(d).match(/^(\d{4})-(\d{2})/);
      if (m) return `${m[2]}/${m[1]}`;
      const y = String(d).match(/^(\d{4})/);
      if (y) return `01/${y[1]}`;
      return d;
    }

    let entriesFilled = 0;
    for (let i = 0; i < workExp.length; i++) {
      const exp = workExp[i];
      const addBtn = findAddWorkHistoryButton();
      if (!addBtn) {
        console.log(`AutoApply: iCIMS WH — no Add button found at entry ${i + 1}, stopping`);
        break;
      }

      addBtn.click();
      // Wait for the inline form / modal to appear
      await new Promise(r => setTimeout(r, 1200));

      // Fill company
      const companyInput = findWHField(["employer", "company", "organization", "orgname"]);
      if (companyInput) setNativeValue(companyInput, exp.company || "");

      // Fill job title
      const titleInput = findWHField(["jobtitle", "job_title", "title", "position"]);
      if (titleInput) setNativeValue(titleInput, exp.title || exp.role || "");

      // Fill start date
      const startInput = findWHField(["startdate", "start_date", "datefrom", "date_from", "begindate"]);
      if (startInput) setNativeValue(startInput, fmtDate(exp.startDate));

      // Fill end date (skip if current position)
      const isCurrent = exp.current || (exp.endDate || "").toLowerCase().includes("present");
      if (!isCurrent) {
        const endInput = findWHField(["enddate", "end_date", "dateto", "date_to"]);
        if (endInput) setNativeValue(endInput, fmtDate(exp.endDate));
      } else {
        // Tick the "currently work here" checkbox
        const currentCb = document.querySelector(
          'input[type="checkbox"][id*="current" i], input[type="checkbox"][name*="current" i]'
        );
        if (currentCb && !currentCb.checked) currentCb.click();
      }

      // Fill description / duties
      const descInput = findWHField(["description", "duties", "jobdesc", "jobnotes", "summary", "responsibilities"]);
      if (descInput) setNativeValue(descInput, exp.description || exp.summary || "");

      // Click the Save/Add button inside the inline form if present
      await new Promise(r => setTimeout(r, 300));
      const saveBtns = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
        .filter(b => {
          const t = (b.textContent || b.value || "").trim().toLowerCase();
          return /^save$/i.test(t) || /^add$/i.test(t) || /save record/i.test(t) || /save entry/i.test(t);
        });
      if (saveBtns.length > 0) {
        saveBtns[saveBtns.length - 1].click(); // click the last matching save (modal footer)
        await new Promise(r => setTimeout(r, 800));
      }

      entriesFilled++;
      console.log(`AutoApply: iCIMS WH — filled entry ${i + 1}: "${exp.title}" at "${exp.company}"`);
    }

    console.log(`AutoApply: iCIMS Work History fill complete — ${entriesFilled} entr${entriesFilled === 1 ? "y" : "ies"} filled`);
    return entriesFilled;
  }

  /**
   * Fill Oracle Taleo-specific form fields.
   * Taleo uses predictable flex field IDs (flex_First_Name_1, etc.) and
   * older name-attribute patterns (ftfn, ftln, ftem, ftph).
   * Returns the count of fields filled.
   */
  function fillTaleoForm(user) {
    let filled = 0;
    const mappings = [
      {
        selectors: [
          'input[id="flex_First_Name_1"]',
          'input[name*="ftfn"]',
          'input[id*="fname" i]',
          'input[id*="firstname" i]',
          'input[name*="firstname" i]',
        ],
        value: user.firstName,
      },
      {
        selectors: [
          'input[id="flex_Last_Name_1"]',
          'input[name*="ftln"]',
          'input[id*="lname" i]',
          'input[id*="lastname" i]',
          'input[name*="lastname" i]',
        ],
        value: user.lastName,
      },
      {
        selectors: [
          'input[id="flex_Email_Address_1"]',
          'input[name*="ftem"]',
          'input[id*="email" i]',
          'input[name*="email" i]',
          'input[type="email"]',
        ],
        value: user.email,
      },
      {
        selectors: [
          'input[id="flex_Phone_1"]',
          'input[name*="ftph"]',
          'input[id*="phone" i]',
          'input[name*="phone" i]',
        ],
        value: user.phone,
      },
      {
        selectors: [
          'input[id*="address" i]',
          'input[name*="address" i]',
        ],
        value: user.address,
      },
      {
        selectors: [
          'input[id*="city" i]',
          'input[name*="city" i]',
        ],
        value: user.city || "Vancouver",
      },
    ];

    for (const { selectors, value } of mappings) {
      if (!value) continue;
      for (const sel of selectors) {
        try {
          const input = document.querySelector(sel);
          if (input && !input.value) {
            setNativeValue(input, value);
            filled++;
            break;
          }
        } catch (_) {}
      }
    }

    console.log(`AutoApply: Taleo-specific fill: ${filled} fields`);
    return filled;
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

    // Reset ALL inherited/page styles on the banner root so site CSS can't bleed in
    // Set non-background properties first, then background separately so
    // backdrop-filter is never reset by all:initial alongside the bg colour.
    banner.style.cssText = `
      all: initial;
      position: fixed !important;
      top: 0 !important; left: 0 !important; right: 0 !important;
      z-index: 2147483647 !important;
      display: block !important;
      width: 100% !important;
      box-sizing: border-box !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif !important;
      font-size: 14px !important;
      line-height: 1.4 !important;
      color: #fff !important;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18) !important;
    `;
    // Apply backdrop-filter AFTER cssText to ensure all:initial doesn't clobber it
    banner.style.setProperty("backdrop-filter", "blur(16px) saturate(1.4)", "important");
    banner.style.setProperty("-webkit-backdrop-filter", "blur(16px) saturate(1.4)", "important");

    const typeConfig = {
      ai:      { bg: "rgba(49, 46, 129, 0.62)",  icon: "⚡", actor: "Working" },
      info:    { bg: "rgba(49, 46, 129, 0.62)",  icon: "⚡", actor: "Working" },
      user:    { bg: "rgba(120, 53, 15, 0.62)",  icon: "👆", actor: "Action needed" },
      success: { bg: "rgba(6, 78, 59, 0.62)",    icon: "✓", actor: "Done" },
      error:   { bg: "rgba(127, 29, 29, 0.62)",  icon: "!", actor: "Needs attention" },
    };
    const cfg = typeConfig[type] || typeConfig.ai;

    chrome.storage.local.get(["_aa_batchProgress", "tailoredResumePdf"], (result) => {
      const bp = result._aa_batchProgress;
      const hasBatch = bp && bp.total > 0;
      const hasPdf = !!result.tailoredResumePdf;

      // ── Progress bar (top edge, always shown during batch) ──────────────────
      const pct = hasBatch ? Math.round(((bp.current - 1) / bp.total) * 100) : 0;
      const progressBar = hasBatch
        ? `<div style="position:absolute;top:0;left:0;right:0;height:3px;background:rgba(255,255,255,0.2);">
             <div style="height:100%;width:${pct}%;background:rgba(255,255,255,0.75);border-radius:0 2px 2px 0;transition:width 0.5s;"></div>
           </div>`
        : "";

      // ── Top meta row: job counter + company · role (only during batch) ───────
      const metaRow = hasBatch ? (() => {
        const counter = `<span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:rgba(0,0,0,0.22);border-radius:4px;padding:1px 7px;white-space:nowrap;letter-spacing:0.2px;margin:0;">Job ${bp.current} / ${bp.total}</span>`;
        const company = bp.company ? `<span style="display:inline-block;font-size:11px;color:rgba(255,255,255,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;margin:0;">${bp.company}</span>` : "";
        const role    = bp.title   ? `<span style="display:inline-block;font-size:11px;color:rgba(255,255,255,0.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;margin:0;">${bp.title}</span>` : "";
        const salary  = bp.salaryRange ? `<span style="display:inline-block;font-size:11px;color:rgba(255,255,255,0.82);white-space:nowrap;margin:0;">💰 ${bp.salaryRange}</span>` : "";
        const timer   = isAi ? `<span id="aa-elapsed-timer" style="display:inline-block;margin-left:auto;font-size:11px;font-weight:700;color:rgba(255,255,255,0.8);font-variant-numeric:tabular-nums;white-space:nowrap;">0:00</span>` : "";
        return `<div style="display:flex;align-items:center;gap:8px;overflow:hidden;margin:0 0 6px 0;padding:0;flex-wrap:nowrap;">${counter}${company}${role}${salary}${timer}</div>`;
      })() : (isAi ? `<div style="display:flex;justify-content:flex-end;margin:0 0 4px 0;padding:0;"><span id="aa-elapsed-timer" style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.75);font-variant-numeric:tabular-nums;">0:00</span></div>` : "");

      // ── Subtext row ──────────────────────────────────────────────────────────
      const subtextRow = opts.subtext
        ? `<div style="font-size:12px;color:rgba(255,255,255,0.75);margin:3px 0 0 0;padding:0;">${opts.subtext}</div>`
        : "";

      // ── Action buttons ───────────────────────────────────────────────────────
      const btnStyle = `border:none;border-radius:6px;padding:5px 13px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;`;
      const pdfBtnStyle = `${btnStyle}background:#fff;color:#4F46E5;`;
      const pdfBtn = hasPdf
        ? `<button id="aa-btn-download-resume" style="${pdfBtnStyle}">⬇ Resume PDF</button>` : "";

      // Fallback resume button — downloads the tailored PDF from storage
      // (shown when hasPdf is false, i.e. PDF not yet generated or upload not confirmed)
      const resumeLinkStyle = `${btnStyle}background:rgba(255,255,255,0.9);color:#1E3A5F;cursor:pointer;border:none;`;
      const resumeLink = (type === "user" || type === "success" || type === "error")
        ? `<button id="aa-link-resume" style="${resumeLinkStyle}">⬇ Get resume</button>`
        : "";

      let actionRow = "";
      if (type === "error") {
        actionRow = `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">Retry</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.4);">Reload resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.18);color:rgba(255,255,255,0.9);">Skip job</button>
          ${pdfBtn || resumeLink}
        </div>`;
      } else if (type === "user") {
        // "Apply with AutoApply" shown when no pendingApplication but page was scraped
        const applyNowBtn = opts.applyNowJob
          ? `<button id="aa-btn-apply-now" style="${btnStyle}background:#fff;color:#4F46E5;font-weight:700;">🤖 Apply with AutoApply</button>`
          : "";
        actionRow = `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          ${applyNowBtn}
          <button id="aa-btn-retry" style="${btnStyle}background:rgba(255,255,255,0.25);color:#fff;">Try again</button>
          <button id="aa-btn-reload-resume" style="${btnStyle}background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.4);">Reload resume</button>
          <button id="aa-btn-skip"  style="${btnStyle}background:rgba(0,0,0,0.18);color:rgba(255,255,255,0.9);">Skip job</button>
          ${pdfBtn || resumeLink}
        </div>`;
      } else if (type === "success") {
        actionRow = `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          ${pdfBtn || resumeLink}
        </div>`;
      } else if (isAi) {
        const pauseBtn = `<button id="aa-btn-pause" style="${btnStyle}background:rgba(255,255,255,0.18);color:#fff;">⏸ Pause</button>`;
        actionRow = `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">${pauseBtn}${pdfBtn}</div>`;
      } else if (opts.showResume || pdfBtn) {
        const resumeBtn = opts.showResume ? `<button id="aa-btn-resume" style="${btnStyle}background:rgba(255,255,255,0.9);color:#B45309;">▶ Resume</button>` : "";
        actionRow = `<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">${resumeBtn}${pdfBtn}</div>`;
      }

      banner.style.background = cfg.bg;
      banner.innerHTML = `
        <div style="
          all: initial;
          display: block;
          position: relative;
          padding: 10px 20px 12px;
          box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
          color: #fff;
          line-height: 1.4;
        ">
          ${progressBar}
          ${metaRow}
          <div style="font-size:14px;font-weight:600;color:#fff;margin:0;padding:0;">${message}</div>
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

      // "Apply with AutoApply" — self-trigger from ATS page without LinkedIn
      document.getElementById("aa-btn-apply-now")?.addEventListener("click", () => {
        const job = opts.applyNowJob;
        if (!job) return;
        removeBanner();
        chrome.storage.local.set({ pendingApplication: job }, () => {
          window.__autoapply_ats_injected = false;
          setTimeout(() => init(), 300);
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
        showBanner("Job skipped — you can close this tab.", "info");
      });
      // Shared download handler — used by both "⬇ Resume PDF" and "⬇ Get resume" buttons
      function triggerResumeDownload() {
        chrome.storage.local.get(["tailoredResumePdf", "tailoredResumeFilename", "_aa_batchProgress", "pendingApplication"], (r) => {
          if (!r.tailoredResumePdf) {
            // No PDF generated yet — fall back to sending DOWNLOAD_RESUME which
            // triggers the background to generate and download on the fly
            const bp  = r._aa_batchProgress;
            const job = r.pendingApplication;
            const company  = bp?.company  || job?.company  || "Company";
            const jobTitle = bp?.title    || job?.jobTitle || "Resume";
            chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: { company, jobTitle } });
            return;
          }
          // PDF is in storage — download it directly without hitting the server
          const bp  = r._aa_batchProgress;
          const job = r.pendingApplication;
          const company  = (bp?.company  || job?.company  || "Company").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
          const jobTitle = (bp?.title    || job?.jobTitle || "Resume").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
          const filename = r.tailoredResumeFilename || `${company}_${jobTitle}_Resume.pdf`;
          // Build a data URL and click an anchor to trigger the browser download
          const dataUrl = `data:application/pdf;base64,${r.tailoredResumePdf}`;
          const a = document.createElement("a");
          a.href = dataUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          console.log("AutoApply: Resume downloaded:", filename);
        });
      }
      document.getElementById("aa-btn-download-resume")?.addEventListener("click", triggerResumeDownload);
      document.getElementById("aa-link-resume")?.addEventListener("click", triggerResumeDownload);
      document.getElementById("aa-btn-pause")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: true });
        showBanner("⏸ Paused — click Resume when ready.", "user", { showResume: true });
      });
      document.getElementById("aa-btn-resume")?.addEventListener("click", () => {
        chrome.storage.local.set({ _aa_paused: false });
        showBanner("Resuming...", "ai", { subtext: "Picking up where we left off..." });
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
    chrome.storage.local.get(["tailoredResumePdf", "_aa_batchProgress", "pendingApplication", "tailoredResumeFilename"], (result) => {
      if (!result.tailoredResumePdf) return;
      if (document.getElementById("aa-btn-download-resume")) return;
      const wrapper = banner.querySelector("div");
      if (!wrapper) return;
      const btn = document.createElement("button");
      btn.id = "aa-btn-download-resume";
      btn.style.cssText = "border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;background:#fff;color:#4F46E5;margin-top:6px;";
      btn.textContent = "⬇️ Resume";
      btn.addEventListener("click", () => {
        chrome.storage.local.get(["tailoredResumePdf", "_aa_batchProgress", "pendingApplication", "tailoredResumeFilename"], (r) => {
          if (!r.tailoredResumePdf) return;
          const bp  = r._aa_batchProgress;
          const job = r.pendingApplication;
          const company  = (bp?.company  || job?.company  || "Company").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
          const jobTitle = (bp?.title    || job?.jobTitle || "Resume").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
          const filename = r.tailoredResumeFilename || `${company}_${jobTitle}_Resume.pdf`;
          const dataUrl = `data:application/pdf;base64,${r.tailoredResumePdf}`;
          const a = document.createElement("a");
          a.href = dataUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        });
        btn.textContent = "⬇️ Download again";
        btn.disabled = false;
      });
      wrapper.appendChild(btn);
      console.log("AutoApply: Persistent download button injected into banner");
    });
  }

  // Proactively show the download button the moment tailoredResumePdf is ready —
  // survives across showBanner calls since showBanner re-checks storage each time.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.tailoredResumePdf?.newValue) return;
    console.log("AutoApply: tailoredResumePdf ready — injecting persistent download button");
    injectOrRefreshDownloadButton();
  });
})();
