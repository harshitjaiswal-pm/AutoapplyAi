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

// Clear tab from injected tracking when it's closed
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabIds.delete(tabId);
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
    return true;
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
    handleTailorAndFill(message.job)
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

          /* Helper: find the React Select class instance (stateNode) from a control element.
             The instance has setValue(), focusInput(), and other internal methods. */
          function getSelectInstance(control) {
            var fiberKey = Object.keys(control).find(function(k) {
              return k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0;
            });
            if (!fiberKey) {
              // Try parent containers
              var container = control.closest('[class*="select__container"], [class*="select"]') || control.parentElement;
              if (container) {
                fiberKey = Object.keys(container).find(function(k) {
                  return k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0;
                });
                if (fiberKey) control = container;
              }
            }
            if (!fiberKey) return null;

            var fiber = control[fiberKey];
            var current = fiber;
            var maxWalk = 30;
            var instance = null;
            var options = null;

            while (current && maxWalk-- > 0) {
              // React Select class component: has stateNode with focusInput method
              if (current.stateNode && typeof current.stateNode.focusInput === "function") {
                instance = current.stateNode;
                options = instance.props ? instance.props.options : null;
                break;
              }
              current = current.return;
            }

            return { instance: instance, options: options || [] };
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

            if (!result.instance) {
              console.log("AutoApply: [main-world] No Select instance for \"" + item.labelText + "\"");
              // Move to next dropdown after delay
              setTimeout(function() { fillDropdownSequentially(index + 1); }, 300);
              return;
            }

            var options = result.options;
            console.log("AutoApply: [main-world] \"" + item.labelText + "\" has " + options.length + " options");
            var match = findMatch(options, item.value);

            if (match) {
              console.log("AutoApply: [main-world] " + item.labelText + " -> \"" + match.label + "\" (via setValue)");
              // Use React Select's internal setValue method — this properly updates
              // both React Select's internal state AND calls the parent form's onChange,
              // which updates Greenhouse's form validation state.
              result.instance.setValue(match, "select-option", match);
            } else {
              console.log("AutoApply: [main-world] No match for \"" + item.value + "\" in \"" + item.labelText + "\". Available: " +
                options.map(function(o) { return o.label; }).join(" | "));
            }

            // Delay before filling the next dropdown to let React finish re-rendering
            setTimeout(function() { fillDropdownSequentially(index + 1); }, 600);
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
              b.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span style="font-size:11px;font-weight:700;background:rgba(255,255,255,0.2);border-radius:4px;padding:1px 7px;letter-spacing:0.3px;">⚠️ AUTOAPPLY AI</span>
                  <span style="font-size:13px;font-weight:500;">Login required or page changed — sign in then click Retry</span>
                  <button id="aa-retry-btn" style="margin-left:auto;background:rgba(255,255,255,0.25);border:1px solid rgba(255,255,255,0.5);color:#fff;border-radius:5px;padding:3px 12px;font-size:12px;font-weight:600;cursor:pointer;">↩ Retry</button>
                </div>`;
              (document.body || document.documentElement).prepend(b);
              document.getElementById("aa-retry-btn")?.addEventListener("click", () => {
                chrome.runtime.sendMessage({ type: "RETRY_INJECT" });
              });
            },
          }).catch(() => {});
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
        "padding:10px 18px 9px", "box-shadow:0 4px 20px rgba(0,0,0,0.2)",
      ].join(";");
      b.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:11px;font-weight:700;background:rgba(255,255,255,0.2);border-radius:4px;padding:1px 7px;letter-spacing:0.3px;">🤖 AUTOAPPLY AI</span>
          <span style="font-size:13px;font-weight:500;">Opening application — please wait…</span>
          <span style="font-size:12px;opacity:0.7;margin-left:auto;">Loading form filler…</span>
        </div>`;
      document.body ? document.body.prepend(b) : document.documentElement.prepend(b);
    },
  }).catch(() => {}); // page may not be ready yet — silently ignore
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
      await chrome.storage.local.set({
        tailoredResumePdf: base64,
        tailoredResumeFilename: filename,
      });
      console.log("AutoApply BG: Step 3 done. PDF generated.");
      try { AALog && AALog.api("bg.api.exportResume.done", { filename, sizeBytes: arrayBuffer.byteLength }); } catch(_){}
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
 * Download the tailored resume PDF to the user's Downloads folder.
 */
async function handleDownloadResume(job) {
  const stored = await chrome.storage.local.get(["tailoredResumePdf", "tailoredResumeFilename"]);

  if (!stored.tailoredResumePdf) {
    console.warn("AutoApply BG: No PDF to download");
    return;
  }

  // Use data URL directly — URL.createObjectURL is not available in MV3 service workers
  const url = `data:application/pdf;base64,${stored.tailoredResumePdf}`;

  const filename = stored.tailoredResumeFilename ||
    `${job?.company || "Company"}_${job?.jobTitle || "Resume"}_Tailored.pdf`;

  chrome.downloads.download({
    url: url,
    filename: filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_"),
    saveAs: false,
  });
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
