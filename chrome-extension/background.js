/**
 * BACKGROUND SERVICE WORKER — Orchestrator
 *
 * Coordinates the auto-apply flow:
 * 1. LinkedIn content.js sends PREPARE_APPLICATION with job data
 * 2. Background watches for new tabs (external career sites)
 * 3. Injects the generic ATS script into the new tab
 * 4. ATS script sends TAILOR_AND_FILL → Background calls AutoApply API
 * 5. Returns tailored data for form filling + downloads resume PDF
 */

// Load the unified logger so AALog is available in the service worker too.
try { importScripts("logger.js"); } catch (e) { console.error("AALog importScripts failed", e); }

// Handle log batches forwarded from content scripts / popup. We persist them
// via AALog's background write queue so all log writes are serialized in one
// place. Must be registered before any other message handlers so it wins the
// race (though the return-true contract means order doesn't strictly matter).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.__aa_log_batch && Array.isArray(message.entries)) {
    try {
      // Tag entries with the sender tab id so we can correlate across frames.
      const senderTag = sender && sender.tab ? { tabId: sender.tab.id, frameId: sender.frameId } : {};
      const enriched = message.entries.map((e) => ({ ...e, sender: senderTag }));
      // AALog in the background context has bgEnqueueWrite, but it's a closure
      // inside the IIFE. Simpler path: call AALog.event for each so they go
      // through the same pending/flush pipeline as native background logs.
      // However AALog.event also re-logs to console. We want silent persist,
      // so write directly through storage using the same serialised chain
      // that AALog uses. Simplest: push through chrome.storage with a queue.
      if (typeof __aa_persistForeignLogs === "function") {
        __aa_persistForeignLogs(enriched);
      }
    } catch (err) {
      console.error("AutoApply BG: log batch persist failed", err);
    }
    sendResponse && sendResponse({ ok: true });
    return false;
  }
});

// Serialised write for foreign log batches from content scripts. Delegates
// to the shared write chain exposed by logger.js (self.__aa_enqueueLogWrite)
// so background's own logs and foreign logs all serialise through one chain.
function __aa_persistForeignLogs(entries) {
  if (typeof self !== "undefined" && typeof self.__aa_enqueueLogWrite === "function") {
    return self.__aa_enqueueLogWrite(entries);
  }
  // Fallback in the unlikely case logger.js isn't loaded: write directly.
  return new Promise((resolve) => {
    chrome.storage.local.get(["_aa_logs"], (result) => {
      const existing = Array.isArray(result._aa_logs) ? result._aa_logs : [];
      const next = existing.concat(entries);
      const MAX = 2000;
      const trimmed = next.length > MAX ? next.slice(next.length - MAX) : next;
      chrome.storage.local.set({ _aa_logs: trimmed }, resolve);
    });
  });
}

// Track whether we're expecting a new tab from an Apply click
let expectingNewTab = false;
let expectingTimeout = null;

// Track which tab owns the active application so we can detect navigation away
let applyTabId = null;

// Track tabs we've already injected into to prevent double-injection.
// Cloudflare challenges and some ATSs cause the onUpdated event to fire
// twice (challenge page load + real page load), so we need this guard in
// addition to the window.__autoapply_ats_injected guard in the scripts.
const injectedTabIds = new Map(); // tabId -> { url, timestamp }

// Track which job each ATS tab was originally opened for.
// Key: tabId  Value: { jobTitle, company, queuedAt }
// Once a tab is "owned" by a job, we do NOT re-inject it for a different job.
// This prevents the Pixieset tab (from Job 5) from being hijacked by Loopio (Job 6)
// whenever onUpdated fires on the already-open breezy.hr tab.
const ownedByJob = new Map();

// Clear tab from injected tracking when it's closed
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabIds.delete(tabId);
  ownedByJob.delete(tabId);
  if (tabId === applyTabId) {
    console.log("AutoApply BG: apply tab closed — clearing applyTabId");
    applyTabId = null;
    // [AutoQA fix 2026-04-08] _aa_lastAtsTabId was set to the same tabId as applyTabId
    // but was never cleared on tab close, leaving a stale ID in storage that could
    // cause confusing FOCUS_TAB failures on the next application cycle.
    chrome.storage.local.remove(["_aa_lastAtsTabId"]);
  }
});

// Known ATS domains for immediate tab detection
const KNOWN_ATS_DOMAINS = [
  "greenhouse.io",
  "lever.co",
  "myworkdayjobs.com",
  "ashbyhq.com",
  "icims.com",
  // [AutoQA fix 2026-04-08] taleo.net was handled by generic.js detectTaleo() but was
  // missing here, causing Taleo tabs to miss the fast-injection path and rely solely
  // on the time-limited expectingNewTab flag instead.
  "taleo.net",
  // [Fix 2026-04-08] breezy.hr was using the loose expectingNewTab path, which could
  // cause a stale flag to inject into the wrong company's breezy.hr tab. Moving to
  // the KNOWN_ATS_DOMAINS path enforces the pendingApplication guard instead.
  "breezy.hr",
];

/* ── Keep-alive mechanism for MV3 service worker ──
 * MV3 service workers die after ~30s of inactivity.
 * We use chrome.alarms to keep it alive during long API calls.
 */
const KEEPALIVE_ALARM = "autoapply-keepalive";

function startKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // every 24 seconds
  console.log("AutoApply BG: Keep-alive started");
}

function stopKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  console.log("AutoApply BG: Keep-alive stopped");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    console.log("AutoApply BG: Keep-alive ping at", new Date().toISOString());
  }
});

/* ── Extension badge: show batch progress on icon ── */
chrome.storage.onChanged.addListener((changes) => {
  if (changes._aa_batchProgress) {
    const bp = changes._aa_batchProgress.newValue;
    if (bp && bp.active) {
      chrome.action.setBadgeText({ text: `${bp.current}/${bp.total}` });
      chrome.action.setBadgeBackgroundColor({ color: "#4F46E5" });
      chrome.action.setTitle({ title: `AutoApply: Job ${bp.current}/${bp.total} — ${bp.jobTitle} at ${bp.company}` });
    } else {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "AutoApply AI" });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  /* ── From LinkedIn content.js: Store job data before Apply click ── */
  if (message.type === "PREPARE_APPLICATION") {
    try { AALog && AALog.state("bg.prepareApplication", { jobTitle: message.job?.jobTitle, company: message.job?.company }); } catch(_){}
    startKeepAlive(); // Keep alive while waiting for new tab + API calls
    chrome.storage.local.set({ pendingApplication: { ...message.job, _queuedAt: Date.now() } }, () => {
      console.log("AutoApply BG: Stored pending application for", message.job.jobTitle);

      // Start watching for new tabs
      expectingNewTab = true;
      // Auto-expire after 60 seconds (increased from 30 for slow page loads)
      clearTimeout(expectingTimeout);
      expectingTimeout = setTimeout(() => {
        expectingNewTab = false;
        stopKeepAlive();
      }, 60000);

      sendResponse({ success: true });
    });

    // ── Funnel Stage 1: Opened from LinkedIn ────────────────────────────────
    chrome.storage.local.get(["funnelStats"], (stored) => {
      const s = stored.funnelStats || { opened: 0, formFilled: 0, resumeTailored: 0, completed: 0 };
      s.opened = (s.opened || 0) + 1;
      chrome.storage.local.set({ funnelStats: s });
    });

    return true;
  }

  /* ── From ATS scripts: Funnel stage progression ── */
  if (message.type === "FUNNEL_STAGE") {
    const { stage, job } = message;
    chrome.storage.local.get(["funnelStats"], (stored) => {
      const s = stored.funnelStats || { opened: 0, formFilled: 0, resumeTailored: 0, completed: 0 };
      if (stage === "formFilled")     s.formFilled    = (s.formFilled    || 0) + 1;
      if (stage === "resumeTailored") s.resumeTailored = (s.resumeTailored || 0) + 1;
      if (stage === "completed") {
        s.completed = (s.completed || 0) + 1;
        // Also record in applicationHistory for the dashboard table
        if (job) {
          // [AutoQA fix 2026-04-10] ats was hardcoded to "greenhouse" for ALL completions
          // regardless of which ATS actually completed the application. This caused every
          // history entry to show ats="greenhouse" even for Lever, Workday, Ashby, etc.
          // Now reads from message.ats (sent by each ATS script's FUNNEL_STAGE message)
          // and falls back to "unknown" if omitted (e.g. legacy scripts that don't send it).
          recordApplication({
            jobTitle: job.jobTitle || "",
            company: job.company || "",
            jobUrl: job.jobUrl || "",
            ats: message.ats || "unknown",
            resumeFilename: "",
          });
        }
      }
      chrome.storage.local.set({ funnelStats: s }, () => {
        console.log("AutoApply BG: Funnel stage", stage, "— stats:", s);
      });
    });
    sendResponse({ success: true });
    return false;
  }

  /* ── From ATS generic.js: Re-arm expectingNewTab before clicking an apply button ── */
  if (message.type === "EXPECT_CHILD_TAB") {
    expectingNewTab = true;
    clearTimeout(expectingTimeout);
    expectingTimeout = setTimeout(() => {
      expectingNewTab = false;
    }, 30000);
    sendResponse({ success: true });
    return false;
  }

  /* ── From LinkedIn content.js: Open ATS URL directly (fetched from job page) ── */
  if (message.type === "OPEN_ATS_TAB") {
    try { AALog && AALog.nav("bg.openAtsTab", { url: (message.url || "").slice(0, 120) }); } catch(_){}
    if (message.url) {
      chrome.tabs.create({ url: message.url, active: false }, (tab) => {
        // Store tab ID so content.js can track which tab belongs to this job
        chrome.storage.local.set({ _aa_lastAtsTabId: tab.id });
        sendResponse({ success: true, tabId: tab.id });
      });
      return true; // async sendResponse
    }
    sendResponse({ success: true });
    return false;
  }

  /* ── From LinkedIn content.js: Focus an already-opened ATS tab ── */
  if (message.type === "FOCUS_TAB") {
    const tid = message.tabId;
    if (tid) {
      chrome.tabs.get(tid, (tab) => {
        if (chrome.runtime.lastError || !tab) { sendResponse({ success: false }); return; }
        chrome.tabs.update(tid, { active: true }, () => {
          chrome.windows.update(tab.windowId, { focused: true });
          sendResponse({ success: true });
        });
      });
      return true; // async
    }
    sendResponse({ success: false });
    return false;
  }

  /* ── From universal.js: Inject generic.js into the current tab ── */
  if (message.type === "INJECT_FLOATING_TRIGGER") {
    const tabId = sender.tab?.id;
    if (tabId) injectFloatingTrigger(tabId);
    sendResponse({ success: !!tabId });
    return false;
  }

  if (message.type === "INJECT_GENERIC_HERE") {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["logger.js", "ats/generic.js"],
      }).catch((err) => {
        console.warn("AutoApply BG: INJECT_GENERIC_HERE failed for tab", tabId, err.message);
      });
    }
    sendResponse({ success: !!tabId });
    return false;
  }

  /* ── From ATS content scripts: Upload resume PDF in the MAIN world ──
   * Content scripts run in an isolated world — React's __reactProps$ expando
   * properties are set by the page's main world and are NOT visible from the
   * isolated world.  By using chrome.scripting.executeScript({ world:"MAIN" })
   * from the background we can access them directly. ── */
  if (message.type === "UPLOAD_RESUME_MAIN_WORLD") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ success: false, error: "No sender tab ID" }); return false; }
    const { base64Pdf, filename } = message;
    try { AALog && AALog.form("bg.uploadResumeMainWorld.start", { tabId, filename }); } catch(_){}

    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (b64, fname) => {
        try {
          // Decode base64 → File object
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: "application/pdf" });
          const file = new File([blob], fname, { type: "application/pdf" });

          // Find the primary resume / CV file input
          let fileInput = null;
          const all = document.querySelectorAll('input[type="file"]');
          for (const fi of all) {
            const accept = (fi.accept || "").toLowerCase();
            const labelEl = fi.closest("div, section, label")?.querySelector("label, [class*='label']");
            const labelText = (labelEl?.textContent || "").toLowerCase();
            if (accept.includes("pdf") || labelText.includes("resume") || labelText.includes("cv")) {
              fileInput = fi;
              break;
            }
          }
          if (!fileInput && all.length > 0) fileInput = all[0];
          if (!fileInput) return { success: false, error: "No file input found" };

          // Strategy A — React onChange handler (only accessible in main world)
          const reactKey = Object.keys(fileInput).find(k => k.startsWith("__reactProps$"));
          if (reactKey && fileInput[reactKey]?.onChange) {
            const dt = new DataTransfer();
            dt.items.add(file);
            fileInput[reactKey].onChange({
              target: { files: dt.files },
              currentTarget: { files: dt.files },
              preventDefault: () => {},
              stopPropagation: () => {},
              persist: () => {},
              nativeEvent: new Event("change"),
              type: "change",
              bubbles: true,
            });
            return { success: true, strategy: "react-onChange-main-world" };
          }

          // Strategy B — DataTransfer defineProperty + _valueTracker reset (main world)
          const dt2 = new DataTransfer();
          dt2.items.add(file);
          Object.defineProperty(fileInput, "files", {
            value: dt2.files, writable: true, configurable: true,
          });
          if (fileInput._valueTracker) fileInput._valueTracker.setValue("");
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, strategy: "dataTransfer-main-world" };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [base64Pdf, filename],
    }).then((results) => {
      const r = results?.[0]?.result;
      try { AALog && AALog.form("bg.uploadResumeMainWorld.done", { success: r?.success, strategy: r?.strategy, error: r?.error }); } catch(_){}
      sendResponse({ success: r?.success || false, strategy: r?.strategy, error: r?.error });
    }).catch((err) => {
      try { AALog && AALog.error("bg.uploadResumeMainWorld.error", { error: err.message }); } catch(_){}
      sendResponse({ success: false, error: err.message });
    });
    return true; // async sendResponse
  }

  /* ── From ATS content scripts: Tailor resume and return data ── */
  if (message.type === "TAILOR_AND_FILL") {
    const _t0 = Date.now();
    try { AALog && AALog.api("bg.tailorAndFill.start", { company: message.job?.company, jobTitle: message.job?.jobTitle }); } catch(_){}
    startKeepAlive(); // Keep service worker alive during long API calls
    // Pass the actual tab URL so background can store the resume under BOTH keys:
    // the job's applyUrl (which might be a LinkedIn URL) AND the live page URL.
    const tabUrl = sender.tab?.url || "";
    const jobWithTabUrl = { ...message.job, _tabUrl: tabUrl };
    handleTailorAndFill(jobWithTabUrl)
      .then((result) => {
        try { AALog && AALog.api("bg.tailorAndFill.done", { ms: Date.now() - _t0, hasResult: !!result?.tailoredResult, error: result?.error || null }); } catch(_){}
        stopKeepAlive(); sendResponse(result);
      })
      .catch((err) => {
        try { AALog && AALog.error("bg.tailorAndFill.exception", { message: err.message, stack: err.stack, ms: Date.now() - _t0 }); } catch(_){}
        stopKeepAlive(); sendResponse({ error: err.message });
      });
    return true;
  }

  /* ── From ATS content scripts: Generate behavioral answer using AI (Issue #6/#14) ── */
  if (message.type === "GENERATE_BEHAVIORAL_ANSWER") {
    const _t0 = Date.now();
    const { question, jobTitle, company, jobDescription, resumeText } = message;
    try { AALog && AALog.api("bg.generateBehavioralAnswer.start", { jobTitle, company, questionLength: question?.length || 0 }); } catch(_){}
    startKeepAlive();
    handleGenerateBehavioralAnswer(question, jobTitle, company, jobDescription, resumeText)
      .then((result) => {
        try { AALog && AALog.api("bg.generateBehavioralAnswer.done", { ms: Date.now() - _t0, answerLength: result?.answer?.length || 0 }); } catch(_){}
        stopKeepAlive(); sendResponse(result);
      })
      .catch((err) => {
        try { AALog && AALog.error("bg.generateBehavioralAnswer.exception", { message: err.message, ms: Date.now() - _t0 }); } catch(_){}
        stopKeepAlive(); sendResponse({ error: err.message });
      });
    return true;
  }

  /* ── Get stored user profile ── */
  if (message.type === "GET_PROFILE") {
    chrome.storage.local.get(["userProfile"], (stored) => {
      sendResponse({ profile: stored.userProfile || null });
    });
    return true;
  }

  /* ── Save user profile ── */
  if (message.type === "SAVE_PROFILE") {
    chrome.storage.local.set({ userProfile: message.profile }, () => {
      console.log("AutoApply BG: Saved user profile");
      sendResponse({ success: true });
    });
    return true;
  }

  /* ── Get extension status ── */
  if (message.type === "GET_STATUS") {
    chrome.storage.local.get(["completedApplications", "_aa_currentJobNumber"], (stored) => {
      sendResponse({
        expectingNewTab,
        completedCount: (stored.completedApplications || []).length,
        currentJobNumber: stored._aa_currentJobNumber || 0,
      });
    });
    return true;
  }

  /* ── From ATS scripts: Download the tailored resume as PDF ── */
  if (message.type === "DOWNLOAD_RESUME") {
    handleDownloadResume(message.job);
    sendResponse({ success: true });
    return true;
  }

  /* ── Download a specific resume by map key (triggered from dashboard) ── */
  if (message.type === "DOWNLOAD_RESUME_BY_KEY") {
    (async () => {
      const stored = await chrome.storage.local.get(["tailoredResumeMap"]);
      const map    = stored.tailoredResumeMap || {};
      const entry  = map[message.key];
      if (!entry?.pdf) {
        console.warn("AutoApply BG: No PDF for key:", message.key);
        sendResponse({ success: false, error: "not found" });
        return;
      }
      const safeFilename = (entry.filename || `${entry.company}_${entry.jobTitle}_Resume.pdf`).replace(/[^a-zA-Z0-9_\-\.]/g, "_");
      chrome.downloads.download({ url: `data:application/pdf;base64,${entry.pdf}`, filename: safeFilename, saveAs: false });
      sendResponse({ success: true });
    })();
    return true;
  }

  /* ── Return the correct PDF for a specific job (keyed lookup) ── */
  if (message.type === "GET_RESUME_PDF") {
    (async () => {
      const key = makeResumeKey(message.job);
      const stored = await chrome.storage.local.get(["tailoredResumeMap", "tailoredResumePdf", "tailoredResumeFilename"]);
      const map = stored.tailoredResumeMap || {};
      const entry = map[key];
      sendResponse({
        pdf:      entry?.pdf      || stored.tailoredResumePdf      || null,
        filename: entry?.filename || stored.tailoredResumeFilename || null,
        fromKey:  !!entry?.pdf,
      });
    })();
    return true;
  }

  /* ── Generate a cover letter and download as .docx ── */
  if (message.type === "GENERATE_COVER_LETTER") {
    startKeepAlive();
    (async () => {
      try {
        const result = await handleGenerateCoverLetter(message.job);
        // Download .docx immediately
        chrome.downloads.download({
          url:      `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${result.docxBase64}`,
          filename: result.filename,
          saveAs:   false,
        });
        sendResponse({ success: true, coverLetter: result.coverLetter, filename: result.filename });
      } catch(err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  /* ── From ATS content scripts: Generate an answer for a custom application question ── */
  if (message.type === "ANSWER_CUSTOM_QUESTION") {
    startKeepAlive();
    const { question, resumeSummary, jobTitle, company } = message;
    handleAnswerCustomQuestion({ question, resumeSummary, jobTitle, company })
      .then((answer) => { stopKeepAlive(); sendResponse({ answer }); })
      .catch((err) => { stopKeepAlive(); sendResponse({ error: err.message }); });
    return true; // async
  }

  /* ── From ATS scripts: Fill React Select dropdowns via main world ── */
  if (message.type === "FILL_DROPDOWNS_MAIN_WORLD") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: "No tab ID" });
      return true;
    }
    console.log("AutoApply BG: Filling dropdowns in main world for tab", tabId);

    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      args: [message.fields],
      func: function(fields) {
        /* This function runs in the PAGE's main world — full React access.
         *
         * KEY INSIGHT (from live debugging on Greenhouse forms):
         * - Calling props.onChange() on the React Select fiber only updates the
         *   React Select display, NOT the Greenhouse form state (Rs component).
         * - The correct approach is to find the React Select CLASS INSTANCE
         *   (stateNode with focusInput method) and call instance.setValue().
         *   setValue() is React Select's internal method that properly chains
         *   through its state management and calls the parent onChange callback.
         * - Dropdowns MUST be filled SEQUENTIALLY with delays (~600ms) between
         *   each to avoid React batching race conditions that cause some form
         *   state updates to be lost.
         */
        try {
          var controls = document.querySelectorAll('[class*="select__control"]');
          console.log("AutoApply: [main-world] Found " + controls.length + " React Select controls");

          /* Helper: find the best matching option from an options array.
             Issue #7 fix: Added fuzzy matching for city/state combos like "Vancouver, BC, CA" */
          function findMatch(options, value) {
            var vl = value.toLowerCase().trim();
            var match = null;
            // Exact label match
            for (var i = 0; i < options.length; i++) {
              var ol = (options[i].label || "").toLowerCase().trim();
              if (ol === vl) { match = options[i]; break; }
            }
            // Partial match (substring)
            if (!match) {
              for (var i = 0; i < options.length; i++) {
                var ol = (options[i].label || "").toLowerCase().trim();
                if (ol.indexOf(vl) !== -1 || (vl.indexOf(ol) !== -1 && ol.length > 2)) {
                  match = options[i]; break;
                }
              }
            }
            // Fuzzy match for city/state combos: "Vancouver, BC, CA" → find option containing "vancouver"
            if (!match && vl.length > 2) {
              var parts = vl.split(/[,\s]+/).filter(function(p) { return p.length > 1; });
              for (var i = 0; i < options.length; i++) {
                var ol = (options[i].label || "").toLowerCase().trim();
                // Check if option contains any of the significant parts
                for (var p = 0; p < parts.length; p++) {
                  if (ol.indexOf(parts[p]) !== -1) {
                    match = options[i];
                    break;
                  }
                }
                if (match) break;
              }
            }
            // Yes/No pattern matching
            if (!match && (vl === "no" || vl === "yes")) {
              for (var i = 0; i < options.length; i++) {
                var ol = (options[i].label || "").toLowerCase();
                if (vl === "no" && (ol.indexOf("no") === 0 || ol.indexOf("not") !== -1)) { match = options[i]; break; }
                if (vl === "yes" && ol.indexOf("yes") === 0) { match = options[i]; break; }
              }
            }
            return match;
          }

          /* Helper: find the React Select fiber entry point from a control element.
             Returns { instance, options, onChangeProp } where:
             - instance: RS class component stateNode (RS v4, may be null for RS v5)
             - options: available options array
             - onChangeProp: onChange function from fiber props (RS v5 fallback) */
          function getSelectInstance(control) {
            // Walk up to find the fiber key — try the control itself and parent containers
            var fiberKey = Object.keys(control).find(function(k) {
              return k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0;
            });
            if (!fiberKey) {
              var container = control.closest('[class*="select__container"], [class*="select"]') || control.parentElement;
              if (container) {
                fiberKey = Object.keys(container).find(function(k) {
                  return k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0;
                });
                if (fiberKey) control = container;
              }
            }
            if (!fiberKey) return { instance: null, options: [], onChangeProp: null };

            var fiber = control[fiberKey];
            var current = fiber;
            var maxWalk = 50;
            var instance = null;
            var options = null;
            var onChangeProp = null;

            while (current && maxWalk-- > 0) {
              // RS v4: class component with stateNode.focusInput
              if (current.stateNode && typeof current.stateNode.focusInput === "function") {
                instance = current.stateNode;
                options = instance.props ? instance.props.options : null;
                break;
              }
              // RS v5: function component — look for memoizedProps with options + onChange
              var props = current.memoizedProps || current.pendingProps;
              if (props) {
                if (Array.isArray(props.options) && props.options.length > 0) {
                  options = props.options;
                }
                if (!options && Array.isArray(props.value) && props.options) {
                  options = props.options;
                }
                if (typeof props.onChange === "function" && !onChangeProp && options) {
                  onChangeProp = props.onChange;
                }
              }
              current = current.return;
            }

            // If we found options + onChange via function component, that's RS v5
            return { instance: instance, options: options || [], onChangeProp: onChangeProp };
          }

          /* Fallback: DOM click simulation to open dropdown and click the option.
             Used when both RS v4 instance.setValue() and RS v5 onChange prop fail. */
          function clickSelectOption(control, optionLabel, callback) {
            // Click to open the dropdown
            control.click();
            setTimeout(function() {
              // Find the dropdown menu that appeared
              var menu = document.querySelector('[class*="select__menu"]');
              if (!menu) {
                // Try clicking the control's parent (sometimes the clickable area is wrapper)
                var wrapper = control.parentElement;
                if (wrapper) wrapper.click();
                setTimeout(function() { menu = document.querySelector('[class*="select__menu"]'); doClick(menu); }, 300);
                return;
              }
              doClick(menu);
            }, 300);

            function doClick(menu) {
              if (!menu) { callback(false); return; }
              var optionEls = menu.querySelectorAll('[class*="select__option"]');
              var vl = optionLabel.toLowerCase().trim();
              var found = false;
              for (var i = 0; i < optionEls.length; i++) {
                var text = (optionEls[i].textContent || "").toLowerCase().trim();
                if (text === vl || text.indexOf(vl) === 0 || (vl === "no" && text.indexOf("no") === 0) || (vl === "yes" && text.indexOf("yes") === 0)) {
                  optionEls[i].click();
                  found = true;
                  break;
                }
              }
              // Close menu if option not found or to ensure cleanup
              if (!found) {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              }
              callback(found);
            }
          }

          // Build control → field mapping
          var controlMap = [];
          controls.forEach(function(control, idx) {
            var labelText = "";
            var node = control;
            for (var i = 0; i < 8; i++) {
              node = node.parentElement;
              if (!node) break;
              var label = node.querySelector("label");
              if (label) {
                labelText = label.textContent.trim().toLowerCase().replace(/\s*\*\s*$/, "");
                break;
              }
            }
            if (!labelText) return;

            var matchedField = null;
            for (var f = 0; f < fields.length; f++) {
              var field = fields[f];
              for (var l = 0; l < field.labels.length; l++) {
                if (labelText.indexOf(field.labels[l]) !== -1) {
                  matchedField = field;
                  break;
                }
              }
              if (matchedField) break;
            }
            if (!matchedField) return;
            controlMap.push({ control: control, labelText: labelText, value: matchedField.value });
          });

          console.log("AutoApply: [main-world] Matched " + controlMap.length + " dropdowns to fill");

          /* Fill dropdowns SEQUENTIALLY with delays to prevent React batching
             from swallowing form-state updates. Each setValue triggers a React
             re-render; if we fire them all at once, React batches the updates
             and some form-level state changes get lost. */
          function fillDropdownSequentially(index) {
            if (index >= controlMap.length) {
              console.log("AutoApply: [main-world] All " + controlMap.length + " dropdowns filled sequentially");
              return;
            }

            var item = controlMap[index];
            var result = getSelectInstance(item.control);
            var options = result.options;
            console.log("AutoApply: [main-world] \"" + item.labelText + "\" — instance:", !!result.instance, "onChange:", !!result.onChangeProp, "options:", options.length);

            var match = findMatch(options, item.value);

            function next(delay) {
              setTimeout(function() { fillDropdownSequentially(index + 1); }, delay || 700);
            }

            if (!match && options.length === 0) {
              // No options found at all — try DOM click approach directly
              console.log("AutoApply: [main-world] No options for \"" + item.labelText + "\" — trying DOM click");
              clickSelectOption(item.control, item.value, function(ok) {
                console.log("AutoApply: [main-world] DOM click for \"" + item.labelText + "\":", ok ? "success" : "failed");
                next(800);
              });
              return;
            }

            if (!match) {
              console.log("AutoApply: [main-world] No match for \"" + item.value + "\" in \"" + item.labelText + "\". Available: " +
                options.map(function(o) { return o.label; }).join(" | "));
              next(300);
              return;
            }

            if (result.instance) {
              // RS v4: use internal setValue() — most reliable
              console.log("AutoApply: [main-world] " + item.labelText + " -> \"" + match.label + "\" (RS v4 setValue)");
              result.instance.setValue(match, "select-option", match);
              next(700);
            } else if (result.onChangeProp) {
              // RS v5: call onChange prop directly with the option object
              console.log("AutoApply: [main-world] " + item.labelText + " -> \"" + match.label + "\" (RS v5 onChange)");
              try {
                result.onChangeProp(match, { action: "select-option", option: match });
                next(700);
              } catch (e) {
                // RS v5 onChange failed — fall back to DOM click
                console.log("AutoApply: [main-world] RS v5 onChange failed for \"" + item.labelText + "\", trying DOM click:", e.message);
                clickSelectOption(item.control, item.value, function(ok) {
                  console.log("AutoApply: [main-world] DOM click fallback for \"" + item.labelText + "\":", ok ? "success" : "failed");
                  next(800);
                });
              }
            } else {
              // No instance, no onChange prop — use DOM click as last resort
              console.log("AutoApply: [main-world] No RS instance for \"" + item.labelText + "\" — using DOM click");
              clickSelectOption(item.control, item.value, function(ok) {
                console.log("AutoApply: [main-world] DOM click for \"" + item.labelText + "\":", ok ? "success" : "failed");
                next(800);
              });
            }
          }

          // Start the sequential fill chain
          fillDropdownSequentially(0);

          // Also handle native <select> elements (non-React Select)
          document.querySelectorAll("select").forEach(function(sel) {
            var labelText = "";
            var id = sel.id;
            if (id) { var lbl = document.querySelector('label[for="' + id + '"]'); if (lbl) labelText = lbl.textContent.trim().toLowerCase().replace(/\s*\*\s*$/, ""); }
            if (!labelText) { var c = sel.closest("div, fieldset, li"); if (c) { var lbl = c.querySelector("label"); if (lbl) labelText = lbl.textContent.trim().toLowerCase().replace(/\s*\*\s*$/, ""); } }
            if (!labelText) return;
            var matchedField = null;
            for (var f = 0; f < fields.length; f++) { for (var l = 0; l < fields[f].labels.length; l++) { if (labelText.indexOf(fields[f].labels[l]) !== -1) { matchedField = fields[f]; break; } } if (matchedField) break; }
            if (!matchedField) return;
            var vl = matchedField.value.toLowerCase();
            var opts = Array.from(sel.options);
            var m = opts.find(function(o) { return o.text.toLowerCase() === vl; }) || opts.find(function(o) { return o.text.toLowerCase().indexOf(vl) !== -1; });
            if (m) { sel.value = m.value; sel.dispatchEvent(new Event("change", { bubbles: true })); console.log("AutoApply: [main-world native] " + labelText + " -> " + m.text); }
          });

          console.log("AutoApply: [main-world] Dropdown filling initiated (sequential with delays)");
          return { success: true };
        } catch (err) {
          console.error("AutoApply: [main-world] Error:", err);
          return { error: err.message };
        }
      }
    }).then((results) => {
      console.log("AutoApply BG: Main-world dropdown fill completed", results);
      sendResponse({ success: true });
    }).catch((err) => {
      console.error("AutoApply BG: Main-world dropdown fill failed:", err);
      sendResponse({ error: err.message });
    });
    return true; // async sendResponse
  }

  /* ── From floating panel: Re-fill the current ATS page WITHOUT reloading ── */
  if (message.type === "FILL_CURRENT_PAGE") {
    const tabId = sender.tab?.id;
    const url   = sender.tab?.url;
    if (!tabId || !url) { sendResponse({ error: "No tab" }); return false; }

    console.log("AutoApply BG: FILL_CURRENT_PAGE for tab", tabId, url);

    // Step 1: Restore pendingApplication from lastFilledJob (if missing)
    //         so the ATS content script has something to work with.
    chrome.storage.local.get(["pendingApplication", "lastFilledJob"], async (stored) => {
      const hasPending = !!stored.pendingApplication;
      const lastJob    = stored.lastFilledJob;

      if (!hasPending && lastJob) {
        // Re-populate pendingApplication from the last job we worked on
        const restored = {
          id:             lastJob.id,
          jobTitle:       lastJob.jobTitle,
          company:        lastJob.company,
          jobUrl:         lastJob.jobUrl || url,
          applyUrl:       lastJob.jobUrl || url,
          jobDescription: lastJob.jobDescription || "",
          _queuedAt:      Date.now(),
          _restoredForRefill: true,
        };
        await new Promise(r => chrome.storage.local.set({ pendingApplication: restored }, r));
        console.log("AutoApply BG: Restored pendingApplication from lastFilledJob for FILL_CURRENT_PAGE");
      }

      // Step 2: Clear dedup guards so the inject isn't blocked
      injectedTabIds.delete(tabId);
      ownedByJob.delete(tabId);

      // Step 2b: Signal greenhouse.js to self-scrape the current page.
      // This flag takes priority over any stale pendingApplication that may have been
      // restored above (e.g. Career17 when we're actually on Mercury's page).
      await new Promise(r => chrome.storage.local.set({ _aa_scrapeAndTailor: true }, r));
      console.log("AutoApply BG: Set _aa_scrapeAndTailor flag for FILL_CURRENT_PAGE on", url);

      // Step 2c: Clear the in-page injection guard so greenhouse.js actually re-runs.
      // Without this, chrome.scripting.executeScript fires but the script hits
      // `if (window.__autoapply_ats_injected) return;` and exits immediately.
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => { window.__autoapply_ats_injected = false; },
        });
        console.log("AutoApply BG: Cleared __autoapply_ats_injected guard for tab", tabId);
      } catch (e) {
        console.warn("AutoApply BG: Could not clear injection guard:", e.message);
      }

      // Step 3: Re-inject the banner + ATS script (same as normal flow)
      injectInstantBanner(tabId);
      setTimeout(() => injectATSScript(tabId, url), 300);

      sendResponse({ success: true });
    });
    return true; // async
  }

  /* ── Legacy: pipeline bridge support ── */
  if (message.type === "SEND_JOBS_TO_PIPELINE") {
    const { jobs, url } = message;
    chrome.storage.local.set({ pendingJobs: jobs }, () => {
      chrome.tabs.create({ url: `${url}/pipeline?fromExtension=true` });
      sendResponse({ success: true });
    });
    return true;
  }

  /* ── From ATS scripts: Application form was filled successfully ── */
  if (message.type === "APPLICATION_COMPLETED") {
    const job = message.job;
    console.log("AutoApply BG: Application completed for", job.jobTitle, "at", job.company);

    // Clear apply tab tracking — this application is done.
    // Do NOT remove pendingApplication here: in a batch the next job's
    // pendingApplication may already be stored, and removing it would
    // cause "No active application found" on the next ATS page.
    applyTabId = null;

    // Store completed application in a list for the dashboard to read
    chrome.storage.local.get(["completedApplications"], (stored) => {
      const completed = stored.completedApplications || [];
      completed.push({
        ...job,
        status: "applied",
        completedAt: job.completedAt || new Date().toISOString(),
      });
      chrome.storage.local.set({ completedApplications: completed }, () => {
        console.log("AutoApply BG: Saved completed application. Total:", completed.length);
        sendResponse({ success: true });
      });
    });

    // Also update the scraped job status in LinkedIn content script storage
    chrome.storage.local.get(["_aa_scrapedJobs"], (stored) => {
      if (stored._aa_scrapedJobs) {
        const jobs = stored._aa_scrapedJobs;
        const match = jobs.find((j) => j.id === job.id || j.title === job.jobTitle);
        if (match) {
          match.status = "applied";
          chrome.storage.local.set({ _aa_scrapedJobs: jobs });
        }
      }
    });

    return true;
  }

  if (message.type === "CLEAR_SCRAPED_JOBS") {
    chrome.storage.local.remove(["scrapedJobs", "pendingJobs", "pendingApplication", "_aa_scrapedJobs", "_aa_selectedIds"], () => {
      sendResponse({ success: true });
    });
    return true;
  }

  /* ── From amber fallback banner: user clicked Retry after login/redirect ── */
  if (message.type === "RETRY_INJECT") {
    const tabId = sender.tab?.id;
    const url = sender.tab?.url;
    if (tabId && url) {
      console.log("AutoApply BG: RETRY_INJECT received — re-injecting ATS script into tab", tabId);
      // Clear the dedup guard so injectATSScript doesn't skip this tab
      injectedTabIds.delete(tabId);
      injectInstantBanner(tabId);
      setTimeout(() => injectATSScript(tabId, url), 500);
    }
    sendResponse({ success: true });
    return false;
  }

  /* ── Dev utility: reload the extension from any content script ── */
  if (message.type === "RELOAD_EXTENSION") {
    sendResponse({ success: true });
    setTimeout(() => chrome.runtime.reload(), 100);
    return false;
  }

  /* ── From Workday ATS: Click a button-dropdown using CDP trusted click ──
   * Workday button-based dropdowns (Province, Phone Type) check `isTrusted`
   * on click events, so content script clicks don't open them. We use
   * chrome.debugger to dispatch a trusted click via CDP Input.dispatchMouseEvent.
   *
   * message.type: "CDP_CLICK"
   * message.selector: CSS selector of the element to click
   * message.selectOption: (optional) text of dropdown option to select after click
   */
  if (message.type === "CDP_CLICK") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: "No tab ID" });
      return true;
    }

    handleCDPClick(tabId, message.selector, message.selectOption)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  /* ── From ATS scripts: Record application submission ── */
  if (message.type === "RECORD_APPLICATION") {
    recordApplication(message.data || {});
    sendResponse({ success: true });
    return false;
  }
});

/* ── CDP Click: Trusted click for Workday button-based dropdowns ── */
async function handleCDPClick(tabId, selector, selectOption) {
  const debuggee = { tabId };

  try {
    // Attach debugger
    await chrome.debugger.attach(debuggee, "1.3");

    // Get element position via JS evaluation
    const evalResult = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `
        (function() {
          const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
          if (!el) return JSON.stringify({ error: 'Element not found' });
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          return JSON.stringify({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            text: el.textContent?.trim().substring(0, 50)
          });
        })()
      `,
      returnByValue: true,
    });

    const pos = JSON.parse(evalResult.result.value);
    if (pos.error) {
      await chrome.debugger.detach(debuggee);
      return { error: pos.error };
    }

    console.log(`AutoApply BG: CDP clicking at (${pos.x}, ${pos.y}) — "${pos.text}"`);

    // Dispatch trusted mouse click via CDP
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1,
    });

    // Wait for dropdown popup to appear
    await new Promise(r => setTimeout(r, 800));

    // If selectOption provided, find and click the option
    if (selectOption) {
      const optResult = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: `
          (function() {
            const options = document.querySelectorAll('[data-automation-id="promptOption"], [role="option"]');
            for (const opt of options) {
              if (opt.textContent?.trim() === '${selectOption.replace(/'/g, "\\'")}') {
                const rect = opt.getBoundingClientRect();
                return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: opt.textContent.trim() });
              }
            }
            return JSON.stringify({ error: 'Option not found', available: Array.from(options).map(o => o.textContent?.trim()).slice(0, 10) });
          })()
        `,
        returnByValue: true,
      });

      const optPos = JSON.parse(optResult.result.value);
      if (!optPos.error) {
        console.log(`AutoApply BG: CDP clicking option "${optPos.text}" at (${optPos.x}, ${optPos.y})`);
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: optPos.x, y: optPos.y, button: "left", clickCount: 1,
        });
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x: optPos.x, y: optPos.y, button: "left", clickCount: 1,
        });
        await new Promise(r => setTimeout(r, 300));
      } else {
        console.log("AutoApply BG: Option not found:", optPos);
      }
    }

    await chrome.debugger.detach(debuggee);
    return { success: true };
  } catch (err) {
    try { await chrome.debugger.detach(debuggee); } catch (e) { /* already detached */ }
    console.error("AutoApply BG: CDP click error:", err);
    return { error: err.message };
  }
}

/* ── Watch for new tabs opened by Apply clicks ── */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;

  const url = tab.url.toLowerCase();

  // ── Navigation-persistence guard ──────────────────────────────────────────
  // If the apply tab navigated to a non-ATS page (login redirect, cross-domain
  // redirect, etc.) and we still have a pending application, inject an amber
  // "Login required" sticky banner so the user knows what happened.
  if (tabId === applyTabId && !url.includes("linkedin.com") && !url.startsWith("chrome") && !url.startsWith("about:")) {
    const isKnownATSNow = KNOWN_ATS_DOMAINS.some(domain => url.includes(domain));
    if (!isKnownATSNow) {
      // Check if there's still a pending application before showing the banner
      chrome.storage.local.get(["pendingApplication"], (stored) => {
        if (!stored.pendingApplication) {
          // Application already finished — stop tracking this tab
          applyTabId = null;
          return;
        }
        {
          console.log("AutoApply BG: Apply tab navigated away from ATS to:", tab.url, "— injecting fallback banner");
          // Clear dedup guard so re-injection works after Retry
          injectedTabIds.delete(tabId);
          chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              // Remove any existing banner first
              const existing = document.getElementById("autoapply-banner");
              if (existing) existing.remove();
              const b = document.createElement("div");
              b.id = "autoapply-banner";
              b.style.cssText = [
                "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
                "background:linear-gradient(135deg,#B45309 0%,#D97706 100%)",
                "color:#fff", "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
                "padding:10px 18px 9px", "box-shadow:0 4px 20px rgba(0,0,0,0.2)",
              ].join(";");
              b.style.position = "fixed";
              b.innerHTML = `
                <button id="aa-fallback-collapse" style="
                  all:initial;position:absolute;top:6px;right:8px;
                  background:rgba(255,255,255,0.2);border:none;border-radius:4px;
                  color:#fff;font-size:11px;font-weight:700;cursor:pointer;
                  padding:2px 8px;line-height:1.6;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                  z-index:1;" title="Collapse banner">▲</button>
                <div id="aa-fallback-inner" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:32px;">
                  <span style="font-size:11px;font-weight:600;background:rgba(255,255,255,0.18);border-radius:5px;padding:2px 8px;letter-spacing:0.2px;white-space:nowrap;">! AutoApply</span>
                  <span style="font-size:13px;font-weight:500;">Login required or page changed — sign in then click Retry</span>
                  <button id="aa-retry-btn" style="margin-left:auto;background:rgba(255,255,255,0.25);border:1px solid rgba(255,255,255,0.5);color:#fff;border-radius:5px;padding:3px 12px;font-size:12px;font-weight:600;cursor:pointer;">↩ Retry</button>
                </div>`;
              (document.body || document.documentElement).prepend(b);
              document.body.style.paddingTop = (b.offsetHeight || 44) + "px";

              // Collapse / expand
              let _collapsed = false;
              document.getElementById("aa-fallback-collapse")?.addEventListener("click", () => {
                _collapsed = !_collapsed;
                const inner = document.getElementById("aa-fallback-inner");
                const btn = document.getElementById("aa-fallback-collapse");
                if (inner) inner.style.display = _collapsed ? "none" : "flex";
                if (btn) { btn.textContent = _collapsed ? "▼" : "▲"; btn.title = _collapsed ? "Expand banner" : "Collapse banner"; }
                document.body.style.paddingTop = _collapsed ? "28px" : (b.offsetHeight || 0) + "px";
              });

              // Retry — navigate directly to the stored apply URL instead of messaging
              // the service worker (which may have gone idle in MV3).
              document.getElementById("aa-retry-btn")?.addEventListener("click", () => {
                chrome.storage.local.get(["pendingApplication"], (stored) => {
                  const applyUrl = stored.pendingApplication?.applyUrl || stored.pendingApplication?.jobUrl;
                  if (applyUrl) {
                    // Navigate back to the ATS apply page — extension will auto-inject on arrival
                    window.location.href = applyUrl;
                  } else {
                    // No stored URL — fall back to reloading current page
                    window.location.reload();
                  }
                });
              });
            },
          }).catch(() => {});
          // Inject the persistent floating trigger alongside the login banner
          injectFloatingTrigger(tabId);
        }
      });
    }
  }

  // Check if this is a known ATS domain — if so, treat it as the apply tab
  // regardless of expectingNewTab flag (handles race condition where page loads slowly)
  const isKnownATS = KNOWN_ATS_DOMAINS.some(domain => url.includes(domain));

  if (isKnownATS && !url.includes("linkedin.com")) {
    // Only auto-inject if the user actually queued a job — never fire on manual browsing
    chrome.storage.local.get(["pendingApplication"], (stored) => {
      const pending = stored.pendingApplication;
      if (!pending) {
        console.log("AutoApply BG: Known ATS domain but no pendingApplication — skipping auto-inject");
        return;
      }
      // Expire stale pending applications (older than 15 minutes)
      if (pending._queuedAt && (Date.now() - pending._queuedAt) > 15 * 60 * 1000) {
        console.log("AutoApply BG: pendingApplication expired — clearing and skipping");
        chrome.storage.local.remove(["pendingApplication"]);
        return;
      }
      console.log("AutoApply BG: Detected known ATS domain in new tab:", tab.url);
      expectingNewTab = false;
      clearTimeout(expectingTimeout);

      // Show an instant "AutoApply is starting..." banner with 0ms delay so
      // there is no visible gap between leaving LinkedIn and the ATS script loading.
      injectInstantBanner(tabId);

      // Then inject the full ATS script after the page has rendered
      setTimeout(() => {
        injectATSScript(tabId, tab.url);
      }, 2500);
    });
    return;
  }

  // Fall back to original expectingNewTab logic for other cases
  if (!expectingNewTab) return;

  // Skip LinkedIn tabs, extension pages, and chrome:// URLs
  if (url.includes("linkedin.com") || url.startsWith("chrome") || url.startsWith("about:")) return;

  // Skip if it's our own app
  if (url.includes("vercel.app") || url.includes("localhost:3000")) return;

  // This is likely the external career site — inject the generic ATS script
  console.log("AutoApply BG: Detected new tab for external apply:", tab.url);
  expectingNewTab = false;
  clearTimeout(expectingTimeout);

  // Instant banner first, full script after render
  injectInstantBanner(tabId);
  setTimeout(() => {
    injectATSScript(tabId, tab.url);
  }, 2500);
});

/**
 * Immediately inject a lightweight "AutoApply is starting..." banner into a tab.
 * Runs with 0ms delay so there is no visible gap when the user lands on the ATS page.
 * The full ATS script will replace this banner once it loads (~2.5s later).
 */
function injectInstantBanner(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (document.getElementById("autoapply-banner")) return; // already has one
      const b = document.createElement("div");
      b.id = "autoapply-banner";
      b.style.cssText = [
        "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
        "background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 100%)",
        "color:#fff", "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        "padding:10px 18px 9px", "box-shadow:0 2px 16px rgba(0,0,0,0.18),0 1px 4px rgba(0,0,0,0.1)",
        "transition:background 0.35s ease,opacity 0.2s ease",
      ].join(";");
      b.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:11px;font-weight:600;background:rgba(255,255,255,0.18);border-radius:5px;padding:2px 8px;letter-spacing:0.2px;white-space:nowrap;">✦ AutoApply</span>
          <span style="font-size:13px;font-weight:500;">Opening your application…</span>
        </div>`;
      document.body ? document.body.prepend(b) : document.documentElement.prepend(b);
    },
  }).catch(() => {}); // page may not be ready yet — silently ignore

  // Also inject the persistent floating trigger button
  injectFloatingTrigger(tabId);
}

/** Inject a persistent floating "🤖 AutoApply" button in the bottom-right.
 *  Acts as a fallback trigger if the banner crashes or the form doesn't fill.
 *  Safe to call multiple times — skips if already present. */
function injectFloatingTrigger(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Only inject once
      if (document.getElementById("aa-floating-root")) return;

      /* ── Shared styles ── */
      const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      const GRAD = "linear-gradient(135deg,#4F46E5 0%,#7C3AED 100%)";

      /* ── Root wrapper (positions everything) ── */
      const root = document.createElement("div");
      root.id = "aa-floating-root";
      root.style.cssText = "all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;";

      /* ── Panel (hidden initially) ── */
      const panel = document.createElement("div");
      panel.id = "aa-floating-panel";
      panel.style.cssText = [
        "all:initial", "display:none",
        "background:#fff", "border-radius:16px",
        "box-shadow:0 8px 40px rgba(0,0,0,0.16),0 2px 12px rgba(79,70,229,0.12)",
        "border:1px solid rgba(79,70,229,0.1)",
        "width:252px", "overflow:hidden",
        "font-family:" + FONT,
        "transform:translateY(6px)", "opacity:0",
        "transition:opacity 0.15s ease, transform 0.15s ease",
      ].join(";");

      /* ── Panel header ── */
      const header = document.createElement("div");
      header.style.cssText = "background:" + GRAD + ";padding:11px 14px;display:flex;align-items:center;justify-content:space-between;";
      header.innerHTML = `
        <span style="color:#fff;font-size:12px;font-weight:700;font-family:${FONT};letter-spacing:0.2px;">AutoApply</span>
        <span id="aa-panel-status" style="color:rgba(255,255,255,0.65);font-size:10px;font-family:${FONT};"></span>
      `;
      panel.appendChild(header);

      /* ── Action buttons container ── */
      const actions = document.createElement("div");
      actions.style.cssText = "padding:8px;display:flex;flex-direction:column;gap:4px;";
      panel.appendChild(actions);

      /* ── Helper to create an action button ── */
      function makeBtn(emoji, label, sublabel, color, onClick) {
        const btn = document.createElement("button");
        btn.style.cssText = [
          "all:initial", "display:flex", "align-items:center", "gap:10px",
          "width:100%", "padding:9px 12px", "border-radius:10px",
          "cursor:pointer", "transition:background 0.12s",
          "font-family:" + FONT, "box-sizing:border-box",
        ].join(";");
        btn.innerHTML = `
          <span style="font-size:18px;line-height:1;">${emoji}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:700;color:${color};font-family:${FONT};">${label}</div>
            ${sublabel ? `<div style="font-size:10px;color:#9CA3AF;font-family:${FONT};margin-top:1px;">${sublabel}</div>` : ""}
          </div>
        `;
        btn.onmouseenter = () => btn.style.background = "#F3F4F6";
        btn.onmouseleave = () => btn.style.background = "transparent";
        btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return btn;
      }

      /* ── Divider ── */
      function makeDivider() {
        const d = document.createElement("div");
        d.style.cssText = "height:1px;background:#F3F4F6;margin:2px 0;";
        return d;
      }

      /* ── Inline makeResumeKey (mirrors background.js — must stay in sync) ── */
      function makeResumeKey(job) {
        if (!job) return "default";
        const url = job.applyUrl || job.jobUrl || "";
        if (url) {
          try {
            const u = new URL(url);
            return (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
          } catch(_) {}
        }
        const co = (job.company  || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
        const ti = (job.jobTitle || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
        return (co + "_" + ti) || "default";
      }

      /* ── Populate panel based on storage state ── */
      function buildPanel() {
        actions.innerHTML = "";
        chrome.storage.local.get(["lastFilledJob", "pendingApplication", "tailoredResumeMap", "parsedResume", "userProfile"], (stored) => {
          const hasResume = !!stored.parsedResume;
          const lastJob   = stored.lastFilledJob;
          const pending   = stored.pendingApplication;
          const jobInfo   = pending || lastJob;  // prefer current pending over stale lastFilledJob

          // Use keyed map lookup for hasPdf — eliminates the wrong-resume display bug
          const resumeMap = stored.tailoredResumeMap || {};
          const resumeKey = makeResumeKey(jobInfo);
          const mapEntry  = resumeMap[resumeKey];
          const hasPdf    = !!(mapEntry?.pdf);

          // ① Fill this form
          const fillBtn = makeBtn("→", "Fill this form", jobInfo ? `${jobInfo.jobTitle || ""}${jobInfo.company ? " · " + jobInfo.company : ""}`.slice(0, 34) : "Re-run AutoApply on this page", "#4F46E5", () => {
            setStatus("Filling form…");
            chrome.runtime.sendMessage({ type: "FILL_CURRENT_PAGE" }, (r) => {
              setStatus(r?.success ? "Filling… check the page!" : "Error — try reload");
              setTimeout(() => setStatus(""), 4000);
            });
          });
          actions.appendChild(fillBtn);

          actions.appendChild(makeDivider());

          // ── Helper: get the sublabel div inside a makeBtn button ──────────
          function getSublabel(btn) {
            return btn.querySelectorAll("div div")[1] || null;
          }

          // ── ② a: Download existing PDF — short 3s countdown then fire ────
          // Bar shrinks from 100% → 0% in exactly 3 seconds. Accurate because
          // the download itself is near-instant.
          function startDownloadCountdown(btn) {
            if (btn.dataset.counting) return;
            btn.dataset.counting = "1";
            btn.style.opacity = "0.7";
            btn.style.pointerEvents = "none";

            const sublabelEl = getSublabel(btn);
            if (!sublabelEl) return;

            const SECS = 3;
            let remaining = SECS;
            let cancelled = false;
            let tickInterval;

            sublabelEl.innerHTML = `
              <div style="margin-top:4px;display:flex;align-items:center;gap:6px;">
                <span id="aa-dl-count" style="font-size:10px;color:#059669;font-weight:600;font-family:${FONT};min-width:20px;">${SECS}s</span>
                <div style="flex:1;height:3px;background:#E5E7EB;border-radius:2px;overflow:hidden;">
                  <div id="aa-dl-bar" style="height:100%;width:100%;background:#059669;border-radius:2px;"></div>
                </div>
                <span id="aa-dl-cancel" style="font-size:11px;color:#9CA3AF;cursor:pointer;padding:0 2px;font-family:${FONT};" title="Cancel">✕</span>
              </div>`;

            const countEl = sublabelEl.querySelector("#aa-dl-count");
            const barEl   = sublabelEl.querySelector("#aa-dl-bar");
            const cancel  = sublabelEl.querySelector("#aa-dl-cancel");

            function restore() {
              clearInterval(tickInterval);
              btn.style.opacity = "";
              btn.style.pointerEvents = "";
              delete btn.dataset.counting;
              sublabelEl.textContent = "Your AI-customised resume PDF";
            }

            cancel.addEventListener("click", (e) => { e.stopPropagation(); cancelled = true; restore(); });

            // Paint bar at 100%, THEN start the 3s shrink transition
            requestAnimationFrame(() => requestAnimationFrame(() => {
              barEl.style.transition = `width ${SECS}s linear`;
              barEl.style.width = "0%";
            }));

            tickInterval = setInterval(() => {
              if (cancelled) return;
              remaining--;
              if (countEl) countEl.textContent = remaining > 0 ? `${remaining}s` : "…";
              if (remaining <= 0) {
                clearInterval(tickInterval);
                if (!cancelled) {
                  setStatus("Downloading…");
                  chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: jobInfo || {} }, () => {
                    setStatus("Check your downloads!");
                    restore();
                    setTimeout(() => setStatus(""), 3500);
                  });
                }
              }
            }, 1000);
          }

          // ── ② b: Generate (tailor + PDF) — elapsed timer + simulated progress ─
          // We don't know exactly how long tailoring takes (15–45s typically),
          // so we show elapsed time counting UP and a bar that fills using an
          // asymptotic curve. When the API responds the bar jumps to 100%.
          // This gives honest, transparent feedback without fake precision.
          function startGenerateProgress(btn) {
            if (btn.dataset.counting) return;
            btn.dataset.counting = "1";
            btn.style.opacity = "0.7";
            btn.style.pointerEvents = "none";

            const sublabelEl = getSublabel(btn);
            if (!sublabelEl) return;

            let elapsed = 0;

            // Phase labels help the user understand what's happening
            const phases = [
              { after: 0,  label: "Reading job description…" },
              { after: 5,  label: "Matching your experience…" },
              { after: 12, label: "Tailoring bullet points…"  },
              { after: 22, label: "Generating PDF…"           },
              { after: 35, label: "Almost ready…"             },
            ];

            sublabelEl.innerHTML = `
              <div style="margin-top:3px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;">
                  <span id="aa-gen-phase" style="font-size:10px;color:#D97706;font-family:${FONT};">Reading job description…</span>
                  <span id="aa-gen-time" style="font-size:10px;color:#9CA3AF;font-family:${FONT};">0s</span>
                </div>
                <div style="height:3px;background:#E5E7EB;border-radius:2px;overflow:hidden;">
                  <div id="aa-gen-bar" style="height:100%;width:2%;background:#D97706;border-radius:2px;transition:width 1s ease-out;"></div>
                </div>
                <div style="font-size:9px;color:#9CA3AF;font-family:${FONT};margin-top:3px;">usually 20–40s — you'll be notified</div>
              </div>`;

            const phaseEl = sublabelEl.querySelector("#aa-gen-phase");
            const timeEl  = sublabelEl.querySelector("#aa-gen-time");
            const barEl   = sublabelEl.querySelector("#aa-gen-bar");

            setStatus("Tailoring resume…");

            // Fire the request IMMEDIATELY — no artificial delay
            chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", job: jobInfo || {} }, () => {
              clearInterval(tickInterval);
              // Snap bar to 100% then finish
              if (barEl) { barEl.style.transition = "width 0.4s ease-out"; barEl.style.width = "100%"; }
              if (phaseEl) phaseEl.textContent = "Downloading!";
              if (timeEl) timeEl.textContent = elapsed + "s";
              setStatus(`Done in ${elapsed}s — check downloads!`);
              btn.style.opacity = "";
              btn.style.pointerEvents = "";
              delete btn.dataset.counting;
              setTimeout(() => {
                sublabelEl.textContent = "Creates resume PDF for this role";
                setStatus("");
              }, 4000);
            });

            // Tick every second: update elapsed, phase label, and bar width
            // Bar uses asymptotic formula: pct = 88 × (1 − e^(−elapsed/28))
            // This fills quickly at first then slows near 88%, giving realistic feel.
            const tickInterval = setInterval(() => {
              elapsed++;
              const pct = Math.round(88 * (1 - Math.exp(-elapsed / 28)));
              if (timeEl) timeEl.textContent = elapsed + "s";
              if (barEl)  barEl.style.width = pct + "%";
              const phase = [...phases].reverse().find(p => elapsed >= p.after);
              if (phaseEl && phase) phaseEl.textContent = phase.label;
            }, 1000);
          }

          // ── Render the right button ───────────────────────────────────────
          if (hasPdf) {
            const dlBtn = makeBtn("↓", "Download resume", "Your tailored PDF for this role", "#059669", () => {
              startDownloadCountdown(dlBtn);
            });
            actions.appendChild(dlBtn);
          } else if (hasResume) {
            const tailorBtn = makeBtn("✦", "Tailor resume", "Generate a tailored PDF for this role", "#D97706", () => {
              startGenerateProgress(tailorBtn);
            });
            actions.appendChild(tailorBtn);
          }

          // ── ③ Generate cover letter → download as .docx ─────────────────
          function generateCoverLetter(btn) {
            if (btn.dataset.loading) return;
            btn.dataset.loading = "1";
            btn.style.opacity = "0.7";
            btn.style.pointerEvents = "none";
            const sublabelEl = getSublabel(btn);

            // Animated phase labels so user knows it's working (takes ~25-45s)
            const phases = [
              { after: 0,  label: "Reading job description…" },
              { after: 6,  label: "Analysing your resume…"   },
              { after: 14, label: "Writing tailored letter…" },
              { after: 24, label: "Formatting Word doc…"     },
            ];
            let elapsed = 0;
            if (sublabelEl) sublabelEl.innerHTML = `
              <div style="margin-top:3px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;">
                  <span id="aa-cl-phase" style="font-size:10px;color:#7C3AED;font-family:${FONT};">Reading job description…</span>
                  <span id="aa-cl-time" style="font-size:10px;color:#9CA3AF;font-family:${FONT};">0s</span>
                </div>
                <div style="height:3px;background:#E5E7EB;border-radius:2px;overflow:hidden;">
                  <div id="aa-cl-bar" style="height:100%;width:2%;background:#7C3AED;border-radius:2px;transition:width 1s ease-out;"></div>
                </div>
              </div>`;

            const phaseEl = sublabelEl?.querySelector("#aa-cl-phase");
            const timeEl  = sublabelEl?.querySelector("#aa-cl-time");
            const barEl   = sublabelEl?.querySelector("#aa-cl-bar");
            setStatus("Generating cover letter…");

            const tick = setInterval(() => {
              elapsed++;
              const pct = Math.round(85 * (1 - Math.exp(-elapsed / 25)));
              if (timeEl) timeEl.textContent = elapsed + "s";
              if (barEl)  barEl.style.width  = pct + "%";
              const phase = [...phases].reverse().find(p => elapsed >= p.after);
              if (phaseEl && phase) phaseEl.textContent = phase.label;
            }, 1000);

            chrome.runtime.sendMessage({ type: "GENERATE_COVER_LETTER", job: jobInfo || {} }, (resp) => {
              clearInterval(tick);
              btn.style.opacity = "";
              btn.style.pointerEvents = "";
              delete btn.dataset.loading;

              if (resp?.success) {
                // Snap bar to 100%
                if (barEl) { barEl.style.transition = "width 0.3s ease-out"; barEl.style.width = "100%"; }
                setTimeout(() => {
                  if (sublabelEl) sublabelEl.innerHTML = `
                    <div style="margin-top:3px;display:flex;align-items:center;gap:6px;">
                      <span style="font-size:10px;color:#059669;font-family:${FONT};font-weight:600;">✓ Saved to Downloads</span>
                      <span id="aa-cl-copy-inline" style="font-size:10px;color:#7C3AED;cursor:pointer;font-family:${FONT};text-decoration:underline;">copy text</span>
                    </div>`;
                  const copyInline = sublabelEl?.querySelector("#aa-cl-copy-inline");
                  if (copyInline) {
                    copyInline.addEventListener("click", (e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(resp.coverLetter || "").catch(() => {});
                      copyInline.textContent = "copied!";
                      setTimeout(() => { if(copyInline) copyInline.textContent = "copy text"; }, 2000);
                    });
                  }
                }, 350);
                setStatus(`✓ ${resp.filename || "Cover_Letter.docx"}`);
                setTimeout(() => setStatus(""), 5000);
              } else {
                if (sublabelEl) sublabelEl.textContent = resp?.error || "Failed — try again";
                setStatus("");
                setTimeout(() => { if (sublabelEl) sublabelEl.textContent = "Tailored Word doc for this role"; }, 4000);
              }
            });
          }

          const clBtn = makeBtn("✦", "Generate cover letter", "Tailored cover letter (.docx)", "#7C3AED", () => {
            generateCoverLetter(clBtn);
          });
          actions.appendChild(clBtn);

          actions.appendChild(makeDivider());

          // ④ Open job posting in new tab
          const jobPostingUrl = jobInfo?.jobUrl || jobInfo?.applyUrl || jobInfo?.linkedinUrl;
          if (jobPostingUrl) {
            const openBtn = makeBtn("↗", "Open job posting", jobPostingUrl.replace(/^https?:\/\//, "").slice(0, 35), "#6B7280", () => {
              window.open(jobPostingUrl, "_blank");
            });
            actions.appendChild(openBtn);
          }

          // ⑤ Force-reload this page (re-injects ATS script on page load)
          const reloadBtn = makeBtn("↺", "Restart AutoApply", "Reloads page and re-runs AutoApply", "#6B7280", () => {
            window.location.reload();
          });
          actions.appendChild(reloadBtn);
        });
      }

      function setStatus(msg) {
        const el = document.getElementById("aa-panel-status");
        if (el) el.textContent = msg;
      }

      /* ── Main toggle button ── */
      const pill = document.createElement("button");
      pill.id = "aa-floating-trigger";
      pill.innerHTML = "✦ AutoApply";
      pill.style.cssText = [
        "all:initial",
        "background:" + GRAD,
        "color:#fff", "border:none", "border-radius:999px",
        "padding:10px 20px", "font-size:13px", "font-weight:700",
        "font-family:" + FONT,
        "cursor:pointer", "box-shadow:0 4px 20px rgba(79,70,229,0.45)",
        "display:flex", "align-items:center", "gap:5px",
        "transition:transform 0.15s,box-shadow 0.15s,background 0.2s",
        "white-space:nowrap", "letter-spacing:0.1px",
      ].join(";");
      pill.onmouseenter = () => { pill.style.transform = "scale(1.04)"; pill.style.boxShadow = "0 6px 28px rgba(79,70,229,0.6)"; };
      pill.onmouseleave = () => { pill.style.transform = "scale(1)"; pill.style.boxShadow = "0 4px 20px rgba(79,70,229,0.45)"; };

      function openPanel() {
        buildPanel();
        panel.style.display = "block";
        // Allow display:block to paint, then animate in
        requestAnimationFrame(() => {
          panel.style.opacity = "1";
          panel.style.transform = "translateY(0)";
        });
        pill.innerHTML = "✕ Close";
        pill.style.background = "linear-gradient(135deg,#3730A3 0%,#5B21B6 100%)";
        open = true;
      }

      function closePanel() {
        panel.style.opacity = "0";
        panel.style.transform = "translateY(6px)";
        setTimeout(() => { panel.style.display = "none"; }, 150);
        pill.innerHTML = "✦ AutoApply";
        pill.style.background = GRAD;
        open = false;
      }

      let open = false;
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        if (open) closePanel(); else openPanel();
      });

      // Close panel when clicking outside
      document.addEventListener("click", (e) => {
        if (open && !root.contains(e.target)) closePanel();
      });

      root.appendChild(panel);
      root.appendChild(pill);
      (document.body || document.documentElement).appendChild(root);
    },
  }).catch(() => {});
}

/**
 * Inject the appropriate ATS script into a tab.
 * Falls back to generic.js if no specific ATS is detected.
 */
async function injectATSScript(tabId, url) {
  // Prevent double-injection into the same tab within 60 seconds.
  // Cloudflare challenges cause onUpdated to fire multiple times for the same URL.
  const prior = injectedTabIds.get(tabId);
  if (prior && prior.url === url && Date.now() - prior.timestamp < 60000) {
    console.log(`AutoApply BG: Tab ${tabId} already injected recently at same URL — skipping duplicate injection`);
    try { AALog && AALog.nav("bg.inject.skipDuplicate", { tabId, url }); } catch(_){}
    return;
  }

  // Guard: if this tab was already owned by a DIFFERENT job, don't re-inject.
  // This is the "Pixieset tab hijack" guard — prevents Job 6 (Loopio) from
  // overwriting Job 5's already-open ATS tab when onUpdated fires again on it.
  const ownership = ownedByJob.get(tabId);
  if (ownership) {
    // Check if pendingApplication represents a NEW job (different queuedAt)
    // Wrap in a try-catch in case storage is unavailable
    const storedNow = await new Promise(r => chrome.storage.local.get(["pendingApplication"], r));
    const pending = storedNow.pendingApplication;
    if (!pending || pending._queuedAt === ownership.queuedAt) {
      // Same job OR no pending — this is just an in-form navigation, don't re-inject
      console.log(`AutoApply BG: Tab ${tabId} already owned by job "${ownership.jobTitle}" (queuedAt ${ownership.queuedAt}) — skipping re-injection`);
      try { AALog && AALog.nav("bg.inject.skipOwnedTab", { tabId, url, owner: ownership.jobTitle }); } catch(_){}
      return;
    }
    // New job queued — allow re-injection and update ownership
    console.log(`AutoApply BG: Tab ${tabId} ownership transferred from "${ownership.jobTitle}" to "${pending.jobTitle}"`);
    ownedByJob.delete(tabId);
  }

  injectedTabIds.set(tabId, { url, timestamp: Date.now() });
  applyTabId = tabId; // Track which tab owns the active application
  chrome.storage.local.set({ _aa_lastAtsTabId: tabId }); // Let content.js track per-job tab
  try { AALog && AALog.nav("bg.inject.start", { tabId, url }); } catch(_){}
  const urlLower = url.toLowerCase();

  let scriptFile = "ats/generic.js";
  if (urlLower.includes("greenhouse.io") || urlLower.includes("gh_jid=")) {
    // greenhouse.io hosted OR company-domain Greenhouse embed
    scriptFile = "ats/greenhouse.js";
  } else if (urlLower.includes("lever.co") || urlLower.includes("jobs.lever")) {
    scriptFile = "ats/lever.js";
  } else if (urlLower.includes("myworkdayjobs.com")) {
    scriptFile = "ats/workday.js";
  } else if (urlLower.includes("ashbyhq.com") || urlLower.includes("ashby_jid=")) {
    // ashbyhq.com hosted OR company-domain Ashby embed (e.g. loopio.com/careers/?ashby_jid=...)
    scriptFile = "ats/generic.js";
  } else if (urlLower.includes("icims.com")) {
    scriptFile = "ats/generic.js";
  }

  // For Ashby pages, also inject into child frames (the form may be in a cross-origin iframe)
  const injectIntoAllFrames = scriptFile === "ats/generic.js" &&
    (urlLower.includes("ashby_jid=") || urlLower.includes("ashbyhq.com"));

  // Stamp tab ownership BEFORE executing the script so any onUpdated that fires
  // during script execution sees the ownership and skips re-injection.
  const pendingForOwnership = await new Promise(r => chrome.storage.local.get(["pendingApplication"], r));
  const pendingJob = pendingForOwnership.pendingApplication;
  if (pendingJob) {
    ownedByJob.set(tabId, {
      jobTitle: pendingJob.jobTitle || "",
      company: pendingJob.company || "",
      queuedAt: pendingJob._queuedAt || Date.now(),
    });
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: injectIntoAllFrames },
      files: ["logger.js", scriptFile],
    });
    console.log(`AutoApply BG: Injected ${scriptFile} into tab ${tabId} (allFrames=${injectIntoAllFrames})`);
    try { AALog && AALog.nav("bg.inject.done", { tabId, scriptFile, allFrames: injectIntoAllFrames }); } catch(_){}
  } catch (err) {
    console.error("AutoApply BG: Failed to inject script:", err);
    try { AALog && AALog.error("bg.inject.failed", { tabId, scriptFile, message: err.message }); } catch(_){}
    // Try with generic as fallback
    if (scriptFile !== "ats/generic.js") {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["logger.js", "ats/generic.js"],
        });
        console.log("AutoApply BG: Injected generic.js as fallback");
      } catch (err2) {
        console.error("AutoApply BG: Generic fallback also failed:", err2);
        try { AALog && AALog.error("bg.inject.fallbackFailed", { tabId, message: err2.message }); } catch(_){}
      }
    }
  }
}

/**
 * Retry a function up to maxAttempts times with a delay between attempts.
 * On final failure, re-throws the last error.
 */
async function withRetry(fn, maxAttempts = 3, delayMs = 2000, label = "operation") {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`AutoApply BG: ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      try { AALog && AALog.error(`bg.retry.${label}`, { attempt, maxAttempts, error: err.message }); } catch(_){}
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Call the AutoApply API to tailor the resume for the given job.
 * Optimized: Step 1 (analyze-job) and storage fetch run in parallel.
 * Each API step retries up to 3 times before failing.
 */
async function handleTailorAndFill(job) {
  // Clear any stale PDF from a previous job immediately — this prevents the
  // download button from serving the wrong company's resume while the new
  // tailoring call is in-flight.
  await chrome.storage.local.remove(["tailoredResumePdf", "tailoredResumeFilename"]);

  // Run Step 1 and storage fetch in parallel (Step 1 doesn't depend on stored data)
  const [analyzeRes, stored] = await Promise.all([
    withRetry(() => fetch_analyze_job(job), 3, 2000, "analyzeJob"),
    chrome.storage.local.get(["parsedResume", "autoapplyUrl", "userProfile"]),
  ]);

  if (!stored.parsedResume) {
    throw new Error("No resume found. Upload your resume on the AutoApply pipeline page first.");
  }

  const apiUrl = stored.autoapplyUrl || "https://autoapply-ai-delta.vercel.app";
  console.log("AutoApply BG: Using API URL:", apiUrl);
  console.log("AutoApply BG: Has parsedResume:", !!stored.parsedResume);
  console.log("AutoApply BG: Has userProfile:", !!stored.userProfile);
  console.log("AutoApply BG: JD length:", job.jobDescription?.length || 0);
  // Issue #26: Log job location for debugging
  console.log("AutoApply BG: Job location:", job.jobLocation || job.location || "NOT PROVIDED");

  // Merge userProfile contact info into parsedResume so the AI uses
  // the user's manually-verified data (correct LinkedIn, GitHub, etc.)
  // instead of whatever the PDF parser extracted (often garbled).
  const resumeForApi = { ...stored.parsedResume };
  if (stored.userProfile) {
    const p = stored.userProfile;
    if (!resumeForApi.contactInfo) resumeForApi.contactInfo = {};
    if (p.firstName && p.lastName) resumeForApi.contactInfo.name = `${p.firstName} ${p.lastName}`;
    if (p.email) resumeForApi.contactInfo.email = p.email;
    if (p.phone) resumeForApi.contactInfo.phone = p.phone;
    if (p.linkedin) resumeForApi.contactInfo.linkedin = p.linkedin;
    if (p.github) resumeForApi.contactInfo.github = p.github;
    if (p.portfolio) resumeForApi.contactInfo.portfolio = p.portfolio;
    if (p.workAuthorization) resumeForApi.contactInfo.authorization = p.workAuthorization;
    console.log("AutoApply BG: Merged userProfile into resume contactInfo");
  }

  // Analyze response from parallel execution
  if (!analyzeRes.ok) {
    const errBody = await analyzeRes.text().catch(() => "");
    console.error("AutoApply BG: analyze-job failed:", analyzeRes.status, errBody);
    throw new Error(`Job analysis failed (${analyzeRes.status}): ${errBody.substring(0, 100)}`);
  }

  const analyzeData = await analyzeRes.json();
  // API returns { parsedJob: { title, company, ... } }
  const parsedJob = analyzeData.parsedJob || analyzeData;
  console.log("AutoApply BG: Step 1 done. Parsed job title:", parsedJob.title || parsedJob.jobTitle);
  try { AALog && AALog.api("bg.api.analyzeJob.done", { title: parsedJob.title || parsedJob.jobTitle, keys: Object.keys(parsedJob || {}) }); } catch(_){}

  // Step 2: Tailor the resume (with retry)
  // Issue #26: Ensure jobLocation is passed to the API so the tailor prompt uses the correct location
  console.log("AutoApply BG: Step 2/3 — Tailoring resume for", job.jobTitle);
  try { AALog && AALog.api("bg.api.tailorResume.start", { jobTitle: job.jobTitle, company: job.company }); } catch(_){}

  // Include job location in the request so the backend can use it in the tailoring prompt
  const tailorRequestBody = {
    parsedResume: resumeForApi,
    parsedJob,
    jobLocation: job.jobLocation || job.location, // Pass location to backend
    mode: "fast"
  };

  const tailorData = await withRetry(async () => {
    const res = await fetch(`${apiUrl}/api/tailor-resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tailorRequestBody),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Resume tailoring failed (${res.status}): ${errBody.substring(0, 100)}`);
    }
    return res.json();
  }, 3, 2000, "tailorResume");
  // API returns { tailoredResult: { matchScore, tailoredResume, coverLetter, ... } }
  const tailoredResult = tailorData.tailoredResult || tailorData;
  console.log("AutoApply BG: Step 2 done. Match score:", tailoredResult.matchScore);
  try { AALog && AALog.api("bg.api.tailorResume.done", { matchScore: tailoredResult.matchScore, keys: Object.keys(tailoredResult || {}) }); } catch(_){}

  // Step 3: Generate the resume PDF
  console.log("AutoApply BG: Step 3/3 — Generating PDF for", job.jobTitle);
  let resumeBlobUrl = null;
  try {
    const pdfRes = await fetch(`${apiUrl}/api/export-resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume: tailoredResult.tailoredResume,
        format: "pdf",
      }),
    });

    if (pdfRes.ok) {
      const arrayBuffer = await pdfRes.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      // Use data URL — URL.createObjectURL is not available in MV3 service workers
      resumeBlobUrl = `data:application/pdf;base64,${base64}`;
      // Build numbered filename: e.g. "1_Affirm_Calgary_Senior Product Manager_Resume.pdf"
      // Truncate to max 60 chars before .pdf to prevent upload rejection from ATS file name limits
      const jobNumData = await chrome.storage.local.get(["_aa_currentJobNumber"]);
      const jobNum = jobNumData._aa_currentJobNumber || "";
      const locationPart = job.location ? `_${job.location.split(",")[0].trim()}` : "";
      const prefix = jobNum ? `${jobNum}_` : "";
      const rawFilename = `${prefix}${job.company}${locationPart}_${job.jobTitle}_Resume`;
      const truncatedFilename = rawFilename.length > 60 ? rawFilename.substring(0, 60) : rawFilename;
      const filename = `${truncatedFilename}.pdf`;

      // ── Keyed resume map: each job gets its own slot (fixes wrong-resume bug) ──
      const resumeKey    = makeResumeKey(job);
      // Also key by the live tab URL (_tabUrl injected at message handler).
      // This handles the case where applyUrl was a LinkedIn URL but the form
      // is on Greenhouse — so the download button on the Greenhouse page finds it.
      const tabKey       = job._tabUrl ? makeResumeKey({ applyUrl: job._tabUrl }) : null;
      const mapData      = await chrome.storage.local.get(["tailoredResumeMap"]);
      const resumeMap    = mapData.tailoredResumeMap || {};
      const entryPayload = {
        pdf:        base64,
        filename,
        jobTitle:   job.jobTitle   || "",
        company:    job.company    || "",
        jobUrl:     job.applyUrl   || job.jobUrl || "",
        coverLetter: tailoredResult.coverLetter || "",
        matchScore: tailoredResult.matchScore   || 0,
        createdAt:  Date.now(),
      };
      resumeMap[resumeKey] = entryPayload;
      // Store under live page URL too (if different) so _downloadResumeForPage() always hits
      if (tabKey && tabKey !== resumeKey) {
        resumeMap[tabKey] = entryPayload;
        console.log("AutoApply BG: Also stored under tab URL key:", tabKey);
      }
      // Trim to last 20 resumes by recency
      const mapEntries   = Object.entries(resumeMap).sort((a, b) => b[1].createdAt - a[1].createdAt);
      const trimmedMap   = Object.fromEntries(mapEntries.slice(0, 20));

      await chrome.storage.local.set({
        tailoredResumePdf:      base64,    // backward compat for ATS scripts
        tailoredResumeFilename: filename,  // backward compat for ATS scripts
        tailoredResumeMap:      trimmedMap,
        lastResumeKey:          resumeKey,
      });
      console.log("AutoApply BG: Step 3 done. PDF stored in map key:", resumeKey);
      try { AALog && AALog.api("bg.api.exportResume.done", { filename, sizeBytes: arrayBuffer.byteLength, resumeKey }); } catch(_){}
    } else {
      const errBody = await pdfRes.text().catch(() => "");
      console.warn(`AutoApply BG: PDF export failed: ${pdfRes.status} — ${errBody.substring(0, 200)}`);
      try { AALog && AALog.error("bg.api.exportResume.failed", { status: pdfRes.status, body: errBody.substring(0, 300) }); } catch(_){}
    }
  } catch (pdfErr) {
    console.warn("AutoApply BG: PDF export error:", pdfErr, "— continuing without PDF");
    try { AALog && AALog.error("bg.api.exportResume.exception", { message: pdfErr.message }); } catch(_){}
  }

  await chrome.storage.local.set({
    lastTailoredResult: tailoredResult,
    lastTailoredJob: job,
  });

  console.log("AutoApply BG: All steps complete for", job.jobTitle);

  return {
    tailoredResult,
    resumeBlobUrl,
    matchScore: tailoredResult.matchScore,
    // [AutoQA fix 2026-04-11] Include resumeKey so ATS content script can store it on
    // the page (window.__autoapply_resumeKey) and always download the correct resume.
    // Without this, _downloadResumeForPage() couldn't determine which map entry
    // belonged to the current tab and fell back to the previous job's global PDF.
    resumeKey,
  };
}

/**
 * Generate a behavioral answer to an application question using AI (Issue #6/#14)
 * Mirrors the pattern of handleTailorAndFill but for individual behavioral questions
 */
async function handleGenerateBehavioralAnswer(question, jobTitle, company, jobDescription, resumeText) {
  if (!question) {
    throw new Error("Question text is required");
  }

  const stored = await chrome.storage.local.get(["autoapplyUrl"]);
  const apiUrl = stored.autoapplyUrl || "https://autoapply-ai-delta.vercel.app";

  console.log("AutoApply BG: Generating behavioral answer for:", question.substring(0, 60));

  // Build the prompt for the AI
  const prompt = `You are an applicant for a job application. You are applying for ${jobTitle} at ${company}.

${resumeText ? `Your resume summary: ${resumeText}` : ""}

${jobDescription ? `Job description excerpt: ${jobDescription.substring(0, 500)}` : ""}

Please answer the following application question in 2-3 sentences, in first person, naturally and professionally:

"${question}"

Provide only the answer text, no additional formatting or preamble.`;

  try {
    const res = await fetch(`${apiUrl}/api/generate-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        maxTokens: 150,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("AutoApply BG: Behavioral answer generation failed:", res.status, errBody);
      throw new Error(`Answer generation failed (${res.status})`);
    }

    const data = await res.json();
    const answer = data.answer || data.text || "";

    if (!answer) {
      throw new Error("No answer generated from API");
    }

    console.log("AutoApply BG: Generated behavioral answer, length:", answer.length);
    return { answer };
  } catch (err) {
    console.error("AutoApply BG: Error generating behavioral answer:", err.message);
    throw err;
  }
}

/**
 * Helper: Fetch analyze-job API in parallel
 */
async function fetch_analyze_job(job) {
  const apiUrl = (await chrome.storage.local.get(["autoapplyUrl"])).autoapplyUrl || "https://autoapply-ai-delta.vercel.app";
  console.log("AutoApply BG: Step 1/3 — Analyzing JD for", job.jobTitle);
  try { AALog && AALog.api("bg.api.analyzeJob.start", { jobTitle: job.jobTitle, company: job.company, jdLen: (job.jobDescription || "").length }); } catch(_){}

  try {
    const res = await fetch(`${apiUrl}/api/analyze-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription: job.jobDescription }),
    });
    return res;
  } catch (fetchErr) {
    console.error("AutoApply BG: Network error on analyze-job:", fetchErr);
    try { AALog && AALog.error("bg.api.analyzeJob.networkError", { message: fetchErr.message }); } catch(_){}
    throw new Error(`Network error calling analyze-job: ${fetchErr.message}`);
  }
}

/**
 * Generate a concise answer for an ATS custom question using the API.
 * Calls /api/answer-custom-question with question + candidate context.
 */
async function handleAnswerCustomQuestion({ question, resumeSummary, jobTitle, company }) {
  const stored = await chrome.storage.local.get(["autoapplyUrl"]);
  const apiUrl = stored.autoapplyUrl || "https://autoapply-ai-delta.vercel.app";
  try { AALog && AALog.api("bg.api.answerCustomQuestion.start", { questionPreview: (question || "").slice(0, 80) }); } catch(_){}

  try {
    const res = await fetch(`${apiUrl}/api/answer-custom-question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, resumeSummary, jobTitle, company }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const answer = data.answer || "";
    try { AALog && AALog.api("bg.api.answerCustomQuestion.done", { answerLen: answer.length }); } catch(_){}
    return answer;
  } catch (err) {
    try { AALog && AALog.error("bg.api.answerCustomQuestion.error", { error: err.message }); } catch(_){}
    throw err;
  }
}

/**
 * Generate a deterministic storage key for a job.
 * URL-based when possible (most reliable); falls back to company+title.
 */
function makeResumeKey(job) {
  if (!job) return "default";
  const url = job.applyUrl || job.jobUrl || "";
  if (url) {
    try {
      const u = new URL(url);
      return (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
    } catch(_) {}
  }
  const co = (job.company   || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  const ti = (job.jobTitle  || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  return (co + "_" + ti) || "default";
}

/**
 * Download the tailored resume PDF to the user's Downloads folder.
 * Uses keyed lookup so batch jobs always download the correct resume.
 */
async function handleDownloadResume(job) {
  const resumeKey = makeResumeKey(job);
  const stored    = await chrome.storage.local.get(["tailoredResumeMap", "tailoredResumePdf", "tailoredResumeFilename"]);
  const map       = stored.tailoredResumeMap || {};
  const entry     = map[resumeKey];

  // DEBUG — log full picture so we can trace wrong-resume issues
  console.log("AutoApply BG [handleDownloadResume] job received:", JSON.stringify(job));
  console.log("AutoApply BG [handleDownloadResume] resumeKey:", resumeKey);
  console.log("AutoApply BG [handleDownloadResume] mapKeys:", Object.keys(map));
  console.log("AutoApply BG [handleDownloadResume] entry found:", !!entry, "entry filename:", entry?.filename);
  console.log("AutoApply BG [handleDownloadResume] globalPdf:", !!stored.tailoredResumePdf, "globalFilename:", stored.tailoredResumeFilename);

  // Prefer the keyed entry; fall back to global slot for backward compat
  const base64   = entry?.pdf      || stored.tailoredResumePdf;
  const filename = entry?.filename || stored.tailoredResumeFilename ||
    `${job?.company || "Company"}_${job?.jobTitle || "Resume"}_Tailored.pdf`;

  if (!base64) {
    console.warn("AutoApply BG: No PDF to download (key:", resumeKey, ")");
    return;
  }

  console.log("AutoApply BG: Downloading resume — key:", resumeKey, "fromMap:", !!entry?.pdf, "filename:", filename);
  chrome.downloads.download({
    url:      `data:application/pdf;base64,${base64}`,
    filename: filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_"),
    saveAs:   false,
  });
}

/**
 * Generate a tailored cover letter for a job and export it as a .docx file.
 * Returns { paragraphs, docxBase64, filename, coverLetter (plain text) }.
 */
async function handleGenerateCoverLetter(job) {
  const resumeKey = makeResumeKey(job);
  const stored    = await chrome.storage.local.get(["tailoredResumeMap", "parsedResume", "userProfile", "autoapplyUrl"]);
  const map       = stored.tailoredResumeMap || {};
  const entry     = map[resumeKey];

  const apiUrl   = stored.autoapplyUrl || "https://autoapply-ai-delta.vercel.app";
  const profile  = stored.userProfile  || {};
  const resumeText = stored.parsedResume?.rawText || stored.parsedResume?.text || "";

  const fullName  = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Applicant";
  const firstName = profile.firstName || fullName.split(" ")[0] || "I";

  let paragraphs = entry?.coverLetterParagraphs || null;

  // ── Step 1: Generate AI paragraphs (or use cache) ──────────────────────
  if (!paragraphs) {
    const prompt = `You are writing a professional cover letter body for ${firstName} applying for ${job.jobTitle || "this position"} at ${job.company || "this company"}.

RESUME HIGHLIGHTS (use specific metrics and achievements from here):
${resumeText.substring(0, 2000)}

JOB DESCRIPTION (tailor to these requirements):
${(job.jobDescription || "").substring(0, 1200)}

Write EXACTLY 3 paragraphs separated by a blank line:
1. Opening — genuine enthusiasm for THIS specific company/role + one sentence on why you are a strong fit
2. Achievements — 2–3 specific, quantified accomplishments from the resume that directly address the job requirements (use numbers: %, $, time saved, users, etc.)
3. Closing — forward-looking statement, express desire to discuss further, professional sign-off sentence

Rules:
- First person, confident but not arrogant
- 250–320 words total
- NO salutation, NO sign-off, NO "Dear...", NO "Sincerely" — just the 3 paragraphs
- NO markdown, NO bullet points, NO headers`;

    const aiRes = await fetch(`${apiUrl}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        message:       prompt,
        systemContext: "You are an expert cover letter writer who tailors each letter precisely to the job and resume. Output ONLY the 3 paragraph body. No headers, no salutation, no sign-off, no markdown.",
      }),
    });

    if (!aiRes.ok) throw new Error(`Cover letter AI failed (${aiRes.status})`);
    const aiData   = await aiRes.json();
    const rawText  = aiData.response || aiData.content || aiData.text || aiData.message || "";
    if (!rawText) throw new Error("Empty AI response");

    // Split on blank lines to get individual paragraphs
    paragraphs = rawText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) paragraphs = [rawText.trim()];

    // Cache
    if (entry) {
      entry.coverLetterParagraphs = paragraphs;
      entry.coverLetter = paragraphs.join("\n\n");
      await chrome.storage.local.set({ tailoredResumeMap: map });
    }
  }

  // ── Step 2: Export to .docx via API ────────────────────────────────────
  const exportRes = await fetch(`${apiUrl}/api/export-cover-letter`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      paragraphs,
      name:     fullName,
      email:    profile.email    || "",
      phone:    profile.phone    || "",
      city:     profile.city     || "",
      province: profile.province || "",
      linkedin: profile.linkedin || "",
      jobTitle: job.jobTitle || "",
      company:  job.company  || "",
    }),
  });

  if (!exportRes.ok) throw new Error(`Cover letter export failed (${exportRes.status})`);

  const arrayBuffer = await exportRes.arrayBuffer();
  const base64      = arrayBufferToBase64(arrayBuffer);

  // Build filename
  const co  = (job.company  || "Company").replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 25);
  const ti  = (job.jobTitle || "Role").replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 25);
  const filename = `Cover_Letter_${co}_${ti}.docx`.replace(/\s+/g, "_");

  return {
    docxBase64: base64,
    filename,
    coverLetter: paragraphs.join("\n\n"),  // plain text for clipboard fallback
  };
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Record an application submission to local storage (and Supabase when configured).
 * Called when "Application Submitted" confirmation is detected in Workday/Greenhouse.
 */
async function recordApplication(jobData) {
  try {
    const record = {
      id: `app_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      jobTitle: jobData.jobTitle || "",
      company: jobData.company || "",
      location: jobData.location || "",
      ats: jobData.ats || "unknown", // "workday", "greenhouse", etc.
      jobUrl: jobData.jobUrl || "",
      jobDescription: jobData.jobDescription || "",
      resumeFilename: jobData.resumeFilename || "",
      status: "Applied",
    };

    // Save to local applicationHistory
    chrome.storage.local.get(["applicationHistory"], (result) => {
      const history = Array.isArray(result.applicationHistory) ? result.applicationHistory : [];
      history.push(record);
      chrome.storage.local.set({ applicationHistory: history }, () => {
        console.log("AutoApply BG: Recorded application:", record.jobTitle, "at", record.company);
        try { AALog && AALog.state("bg.recordApplication", { jobTitle: record.jobTitle, company: record.company, ats: record.ats }); } catch(_){}
      });
    });

    // TODO: Also POST to Supabase endpoint when configured
    // const supabaseUrl = await chrome.storage.local.get(["supabaseUrl"]).then(r => r.supabaseUrl);
    // if (supabaseUrl) {
    //   await fetch(`${supabaseUrl}/rest/v1/applications`, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
    //     body: JSON.stringify(record),
    //   });
    // }
  } catch (err) {
    console.error("AutoApply BG: Error recording application:", err);
    try { AALog && AALog.error("bg.recordApplication.error", { error: err.message }); } catch(_){}
  }
}

/**
 * Initialize extension state on install or startup
 */
function initializeExtension() {
  // Clear any stale pending state from a previous session so it doesn't
  // auto-trigger injection on the next browser launch.
  chrome.storage.local.remove(["pendingApplication", "pendingJobs"]);
  chrome.storage.local.set({
    autoapplyUrl: "https://autoapply-ai-delta.vercel.app",
  });
  console.log("AutoApply BG: Extension initialized with default settings");
}

/* ── Extension Install ── */
chrome.runtime.onInstalled.addListener(() => {
  initializeExtension();
});

/* ── Extension Startup (persistence after restart) ── */
chrome.runtime.onStartup.addListener(() => {
  console.log("AutoApply BG: Extension restarted, re-initializing state");
  initializeExtension();
  expectingNewTab = false;
  clearTimeout(expectingTimeout);
});

/* ── Programmatic Content Script Injection ──
 * Chrome aggressively caches manifest-based content scripts.
 * This ensures the LATEST content.js always runs on LinkedIn job pages,
 * bypassing Chrome's content script cache after extension reload.
 * Also handles LinkedIn jobs search and collections pages.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    const url = tab.url.toLowerCase();
    // Inject on LinkedIn job pages, search results, and collections
    if (url.includes("linkedin.com/jobs/") ||
        url.includes("linkedin.com/jobs/search") ||
        url.includes("linkedin.com/jobs/collections")) {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["logger.js", "content.js"],
      }).then(() => {
        console.log("AutoApply BG: Programmatically injected content.js into tab", tabId);
      }).catch((err) => {
        // Silently ignore — tab might have navigated away or lack permission
        console.log("AutoApply BG: Could not inject content.js:", err.message);
      });
    }
  }
});
