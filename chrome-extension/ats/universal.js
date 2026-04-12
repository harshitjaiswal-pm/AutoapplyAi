/**
 * AutoApply Universal Content Script
 *
 * Runs on ALL https pages (except LinkedIn, vercel.app, chrome:// etc.).
 * Detects job postings and shows a floating "Apply with AutoApply" button.
 * The user can trigger AutoApply from any career site, recruiter page,
 * company careers page — without going through LinkedIn first.
 *
 * Flow:
 * 1. On page load, run lightweight job-page heuristics
 * 2. If job posting detected → show small floating button
 * 3. User clicks button → show scan panel
 * 4. Panel scrapes job details + shows "Apply" button
 * 5. Clicking Apply → stores pendingApplication + triggers ATS fill if form present,
 *    otherwise opens the job's apply URL in the current tab
 */

(() => {
  if (window.__autoapply_universal_injected) return;
  window.__autoapply_universal_injected = true;

  const LOG = (...a) => console.log("AutoApply Universal:", ...a);

  // Don't run scan panel on pages where a dedicated ATS script is already running,
  // but still inject the floating pill so the user always has access to it.
  if (window.__autoapply_ats_injected) {
    if (!document.getElementById("aa-floating-root")) {
      chrome.runtime.sendMessage({ type: "INJECT_FLOATING_TRIGGER" });
    }
    return;
  }

  /* ── Job Page Detection ────────────────────────────────────────────────── */

  function detectJobPage() {
    const text  = (document.body?.innerText || "").toLowerCase();
    const title = (document.title || "").toLowerCase();
    const url   = window.location.href.toLowerCase();
    const html  = (document.body?.innerHTML || "").toLowerCase();

    // Bail immediately on clearly non-job pages
    if (!text || text.length < 100) return false; // page not rendered yet
    if (url.includes("google.com") || url.includes("facebook.com") || url.includes("twitter.com")) return false;

    // URL-based strong signals — company career portals
    const jobUrlPatterns = [
      /\/jobs\/\w/, /\/job\/\w/, /\/careers\/\w/, /\/career\/\w/,
      /\/positions\/\w/, /\/openings\/\w/, /\/opportunities\/\w/,
      /\/en\/job\//, /\/us\/en\//, // eBay pattern
    ];
    if (jobUrlPatterns.some(p => p.test(url))) {
      // URL looks like a job page — just need minimal content confirmation
      if (text.length > 300) return true;
    }

    // Strong content signals — any one is enough
    const strongSignals = [
      /apply\s*(now|for|here|today)/i.test(html),
      /(job|position|role|opening)\s*(description|overview|summary)/i.test(text),
      text.includes("responsibilities") && text.includes("qualifications"),
      text.includes("what you'll do") || text.includes("what you will do"),
      text.includes("what we're looking for") || text.includes("what we are looking for"),
      text.includes("about the role") || text.includes("about this role"),
      text.includes("about the position") || text.includes("about the job"),
      text.includes("hybrid") && (text.includes("toronto") || text.includes("remote") || text.includes("onsite")),
    ];
    if (strongSignals.some(Boolean)) return true;

    // Weaker signals — need 2+
    const weakSignals = [
      /\b(engineer|developer|manager|analyst|designer|director|coordinator|specialist|consultant|associate|architect|lead)\b/i.test(title),
      url.includes("/jobs") || url.includes("/careers") || url.includes("/job-") || url.includes("/position"),
      text.includes("compensation") || text.includes("salary range") || text.includes("pay range"),
      text.includes("requirements") && (text.includes("experience") || text.includes("skills")),
      text.includes("benefits") && text.includes("experience"),
    ];
    return weakSignals.filter(Boolean).length >= 2;
  }

  /* ── Job Scraping ─────────────────────────────────────────────────────── */

  function scrapeJobFromPage() {
    // Title: try common selectors, then fall back to page title
    const titleSelectors = [
      'h1[class*="job"], h1[class*="title"], h1[class*="role"], h1[class*="position"]',
      '[data-testid*="job-title"], [data-testid*="title"]',
      '.job-title, .posting-headline, .position-title, .role-title',
      'h1',
    ];
    let title = "";
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim().length > 3 && el.textContent.trim().length < 120) {
        title = el.textContent.trim();
        break;
      }
    }
    if (!title) title = document.title.split(/[|\-–—]/)[0].trim();

    // Company: try meta tags, structured data, common selectors
    let company = "";
    const metaOrg = document.querySelector('meta[property="og:site_name"], meta[name="author"]');
    if (metaOrg) company = metaOrg.getAttribute("content") || "";

    if (!company) {
      const companySelectors = [
        '.company-name, .employer-name, [class*="company"], [class*="employer"]',
        '[data-testid*="company"], [data-testid*="employer"]',
      ];
      for (const sel of companySelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) { company = el.textContent.trim(); break; }
      }
    }
    if (!company) {
      // Derive from hostname (e.g. "airbus.wd3.myworkdayjobs.com" → "Airbus")
      const host = window.location.hostname.replace(/^www\./, "").split(".")[0];
      company = host.charAt(0).toUpperCase() + host.slice(1);
    }

    // Location
    let location = "";
    const locSelectors = ['.location, .job-location, [class*="location"], [data-testid*="location"]'];
    for (const sel of locSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { location = el.textContent.trim().substring(0, 80); break; }
    }

    // Job description: large text blocks
    const descSelectors = [
      '[class*="description"], [class*="job-body"], [class*="content"], [class*="posting"]',
      'article, main, .job, #job',
    ];
    let description = "";
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.length > 200) { description = el.innerText.trim().substring(0, 4000); break; }
    }

    // Apply URL: find the most prominent "Apply" link/button
    let applyUrl = "";
    const applyTexts = /apply\s*(for|now|here|today|externally)?/i;
    for (const el of document.querySelectorAll('a[href], button')) {
      if (applyTexts.test(el.textContent?.trim() || "")) {
        const href = el.href || el.getAttribute("href");
        if (href && !href.startsWith("javascript") && !href.startsWith("#") && href.length > 5) {
          applyUrl = href;
          break;
        }
      }
    }
    if (!applyUrl) applyUrl = window.location.href;

    return { title, company, location, description, applyUrl, sourceUrl: window.location.href };
  }

  /* ── Floating Button ──────────────────────────────────────────────────── */

  function showFloatingButton() {
    if (document.getElementById("aa-universal-btn")) return;

    const btn = document.createElement("div");
    btn.id = "aa-universal-btn";
    btn.style.cssText = `
      all: initial !important;
      position: fixed !important;
      bottom: 24px !important;
      right: 24px !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%) !important;
      color: #fff !important;
      border-radius: 28px !important;
      padding: 10px 18px 10px 14px !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
      box-shadow: 0 4px 20px rgba(79,70,229,0.45) !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      transition: transform 0.15s, box-shadow 0.15s !important;
      user-select: none !important;
      line-height: 1.4 !important;
    `;
    btn.innerHTML = `<span style="font-size:16px !important;color:#fff !important;">A</span> <span style="color:#fff !important;">Apply with AutoApply</span>`;
    btn.onmouseenter = () => { btn.style.transform = "scale(1.04)"; btn.style.boxShadow = "0 6px 28px rgba(79,70,229,0.55)"; };
    btn.onmouseleave = () => { btn.style.transform = ""; btn.style.boxShadow = "0 4px 20px rgba(79,70,229,0.45)"; };
    btn.onclick = () => showScanPanel();
    document.body.appendChild(btn);
  }

  /* ── Scan Panel ───────────────────────────────────────────────────────── */

  function showScanPanel() {
    // Remove old panel if open
    document.getElementById("aa-universal-panel")?.remove();

    const job = scrapeJobFromPage();

    const panel = document.createElement("div");
    panel.id = "aa-universal-panel";
    panel.style.cssText = `
      all: initial !important;
      position: fixed !important;
      bottom: 80px !important;
      right: 24px !important;
      z-index: 2147483647 !important;
      background: #fff !important;
      border-radius: 16px !important;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18) !important;
      width: 340px !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
      overflow: hidden !important;
      display: block !important;
      color: #111 !important;
      line-height: 1.4 !important;
      font-size: 14px !important;
    `;

    panel.innerHTML = `
      <div style="background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 100%);color:#fff;padding:14px 16px 12px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:14px;font-weight:700;">AutoApply</div>
          <div style="font-size:11px;opacity:0.8;margin-top:1px;">Job detected on this page</div>
        </div>
        <button id="aa-panel-close" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:2px 6px;opacity:0.8;">&times;</button>
      </div>
      <div style="padding:14px 16px;">
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Job Title</div>
          <div id="aa-scan-title" style="font-size:13px;font-weight:600;color:#111;line-height:1.3;">${escHtml(job.title || "Unknown")}</div>
        </div>
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Company</div>
          <div style="font-size:13px;color:#374151;">${escHtml(job.company || "Unknown")}</div>
        </div>
        ${job.location ? `<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Location</div><div style="font-size:13px;color:#374151;">${escHtml(job.location)}</div></div>` : ""}
        <div style="margin-bottom:14px;">
          <div style="font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Apply URL</div>
          <div style="font-size:11px;color:#4F46E5;word-break:break-all;line-height:1.4;">${escHtml((job.applyUrl || window.location.href).substring(0, 80))}${(job.applyUrl || "").length > 80 ? "…" : ""}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="aa-panel-apply" style="
            flex:1;background:#4F46E5;color:#fff;border:none;border-radius:8px;
            padding:10px;font-size:13px;font-weight:600;cursor:pointer;
          ">Apply to this Job</button>
          <button id="aa-panel-resume-dl" style="
            display:none;background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;border:none;border-radius:8px;
            padding:10px 12px;font-size:12px;font-weight:700;cursor:pointer;
            box-shadow:0 2px 6px rgba(79,70,229,0.3);
          ">↓ Resume</button>
          <button id="aa-panel-rescan" style="
            background:#F5F5F5;border:1px solid #E5E5E5;border-radius:8px;
            padding:10px 12px;font-size:12px;font-weight:500;cursor:pointer;color:#333;
          ">Re-scan</button>
        </div>
        <div id="aa-panel-status" style="margin-top:8px;font-size:11px;color:#6B7280;text-align:center;"></div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector("#aa-panel-close").onclick = () => panel.remove();
    panel.querySelector("#aa-panel-rescan").onclick = () => { panel.remove(); showScanPanel(); };
    panel.querySelector("#aa-panel-apply").onclick = () => triggerApply(job, panel);

    // Show resume download button if a tailored PDF is available
    const resumeDlBtn = panel.querySelector("#aa-panel-resume-dl");
    if (resumeDlBtn) {
      chrome.storage.local.get(["tailoredResumeMap", "tailoredResumePdf"], (result) => {
        const hasPdf = !!result.tailoredResumePdf || Object.keys(result.tailoredResumeMap || {}).length > 0;
        if (hasPdf) {
          resumeDlBtn.style.display = "inline-block";
          resumeDlBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: { applyUrl: window.location.href } });
            resumeDlBtn.textContent = "↓ Downloading…";
            setTimeout(() => { resumeDlBtn.textContent = "↓ Resume"; }, 2000);
          });
        }
      });
    }
  }

  function escHtml(str) {
    return String(str || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  /* ── Apply Trigger ────────────────────────────────────────────────────── */

  async function triggerApply(job, panel) {
    const statusEl = panel.querySelector("#aa-panel-status");
    const applyBtn = panel.querySelector("#aa-panel-apply");
    applyBtn.disabled = true;
    applyBtn.textContent = "Starting…";
    if (statusEl) statusEl.textContent = "Storing job details…";

    const pendingJob = {
      jobTitle:       job.title,
      company:        job.company,
      location:       job.location,
      jobDescription: job.description,
      applyUrl:       job.applyUrl,
      jobId:          "universal_" + Date.now(),
      easyApply:      false,
    };

    // Store as pendingApplication so ATS scripts can pick it up
    await new Promise(resolve => chrome.storage.local.set({ pendingApplication: pendingJob }, resolve));

    // Also write minimal batchProgress so the banner pills render correctly
    await new Promise(resolve => chrome.storage.local.set({
      _aa_batchProgress: {
        current: 1, total: 1,
        title: job.title, jobTitle: job.title, company: job.company,
        location: job.location, active: true,
      },
    }, resolve));

    // Determine how to proceed:
    // A) Current page IS an application form → trigger ATS injection here
    // B) Current page is a job description → navigate to applyUrl
    const isFormPage = !!document.querySelector('input[type="text"], input[type="email"], textarea, select');
    const isJobDescPage = job.applyUrl && job.applyUrl !== window.location.href;

    if (isJobDescPage) {
      if (statusEl) statusEl.textContent = "Opening application form…";
      applyBtn.textContent = "Opening…";
      setTimeout(() => {
        panel.remove();
        document.getElementById("aa-universal-btn")?.remove();
        window.location.href = job.applyUrl;
      }, 600);
    } else if (isFormPage) {
      // We're on the form already — show the AutoApply banner and let the user know
      if (statusEl) statusEl.textContent = "Form detected — AutoApply is filling it now…";
      applyBtn.textContent = "Filling…";
      panel.remove();
      // Show the ATS banner and trigger generic fill
      showBannerOnPage("AutoApply is filling this form…", "ai");
      // Set _aa_scrapeAndTailor flag so generic.js skips navigation and fills the current page directly
      chrome.storage.local.set({ _aa_scrapeAndTailor: true });
      // Notify background to inject generic.js into this tab
      chrome.runtime.sendMessage({ type: "INJECT_GENERIC_HERE" });
      setTimeout(() => document.getElementById("aa-universal-btn")?.remove(), 500);
    } else {
      // No form detected and same-page URL — still try injecting generic.js to fill whatever is there
      if (statusEl) statusEl.textContent = "Looking for form fields on this page…";
      applyBtn.textContent = "Filling…";
      panel.remove();
      showBannerOnPage("AutoApply is scanning this page for form fields…", "ai");
      // Force-fill mode: skip navigation logic in generic.js
      chrome.storage.local.set({ _aa_scrapeAndTailor: true });
      chrome.runtime.sendMessage({ type: "INJECT_GENERIC_HERE" });
      setTimeout(() => document.getElementById("aa-universal-btn")?.remove(), 500);
    }
  }

  /* ── Minimal Banner for Form Pages ───────────────────────────────────── */

  function showBannerOnPage(message, type) {
    let banner = document.getElementById("autoapply-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "autoapply-banner";
      banner.style.cssText = `all:initial !important;position:fixed !important;top:0 !important;left:0 !important;right:0 !important;z-index:2147483647 !important;color:#fff !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;padding:10px 18px !important;box-shadow:0 4px 20px rgba(0,0,0,0.2) !important;display:block !important;line-height:1.4 !important;`;
      document.body.prepend(banner);
    }
    const bg = type === "error" ? "linear-gradient(135deg,#B91C1C,#DC2626)"
              : type === "user"  ? "linear-gradient(135deg,#B45309,#D97706)"
              : "linear-gradient(135deg,#4F46E5,#7C3AED)";
    banner.style.background = bg;
    banner.innerHTML = `<div style="display:flex !important;align-items:center !important;gap:8px !important;"><span style="font-size:11px !important;font-weight:600 !important;background:rgba(255,255,255,0.18) !important;border-radius:5px !important;padding:2px 8px !important;letter-spacing:0.2px !important;white-space:nowrap !important;color:#fff !important;">✦ AutoApply</span><span style="font-size:13px !important;font-weight:500 !important;color:#fff !important;">${message}</span></div>`;
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  function boot() {
    // Pill already injected — nothing to do
    if (document.getElementById("aa-floating-root")) return true;
    // Ask background.js to inject the floating action panel.
    // This runs even when the ATS banner is already visible — the pill is always wanted.
    LOG("Requesting floating trigger →", window.location.href.substring(0, 80));
    chrome.runtime.sendMessage({ type: "INJECT_FLOATING_TRIGGER" });
    return true;
  }

  function bootWithRetry() {
    boot();
  }

  // Run after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootWithRetry);
  } else {
    bootWithRetry();
  }

  // Also re-run on SPA navigation (React / Vue / Angular) — URL change means new page
  let _lastUrl = location.href;
  const _observer = new MutationObserver(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      // Remove stale button from previous page
      document.getElementById("aa-universal-btn")?.remove();
      document.getElementById("aa-universal-panel")?.remove();
      // Detect new page with retry
      setTimeout(bootWithRetry, 600);
    }
  });
  _observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
