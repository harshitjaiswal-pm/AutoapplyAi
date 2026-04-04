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

// Track whether we're expecting a new tab from an Apply click
let expectingNewTab = false;
let expectingTimeout = null;

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  /* ── From LinkedIn content.js: Store job data before Apply click ── */
  if (message.type === "PREPARE_APPLICATION") {
    startKeepAlive(); // Keep alive while waiting for new tab + API calls
    chrome.storage.local.set({ pendingApplication: message.job }, () => {
      console.log("AutoApply BG: Stored pending application for", message.job.jobTitle);

      // Start watching for new tabs
      expectingNewTab = true;
      // Auto-expire after 30 seconds (increased from 15 for slow page loads)
      clearTimeout(expectingTimeout);
      expectingTimeout = setTimeout(() => {
        expectingNewTab = false;
        stopKeepAlive();
      }, 30000);

      sendResponse({ success: true });
    });
    return true;
  }

  /* ── From ATS content scripts: Tailor resume and return data ── */
  if (message.type === "TAILOR_AND_FILL") {
    startKeepAlive(); // Keep service worker alive during long API calls
    handleTailorAndFill(message.job)
      .then((result) => { stopKeepAlive(); sendResponse(result); })
      .catch((err) => { stopKeepAlive(); sendResponse({ error: err.message }); });
    return true;
  }

  /* ── From ATS scripts: Download the tailored resume as PDF ── */
  if (message.type === "DOWNLOAD_RESUME") {
    handleDownloadResume(message.job);
    sendResponse({ success: true });
    return true;
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

          /* Helper: find the best matching option from an options array */
          function findMatch(options, value) {
            var vl = value.toLowerCase();
            var match = null;
            // Exact label match
            for (var i = 0; i < options.length; i++) {
              var ol = (options[i].label || "").toLowerCase();
              if (ol === vl) { match = options[i]; break; }
            }
            // Partial match
            if (!match) {
              for (var i = 0; i < options.length; i++) {
                var ol = (options[i].label || "").toLowerCase();
                if (ol.indexOf(vl) !== -1 || (vl.indexOf(ol) !== -1 && ol.length > 2)) {
                  match = options[i]; break;
                }
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
});

/* ── Watch for new tabs opened by Apply clicks ── */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!expectingNewTab) return;
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;

  // Skip LinkedIn tabs, extension pages, and chrome:// URLs
  const url = tab.url.toLowerCase();
  if (url.includes("linkedin.com") || url.startsWith("chrome") || url.startsWith("about:")) return;

  // Skip if it's our own app
  if (url.includes("vercel.app") || url.includes("localhost:3000")) return;

  // This is likely the external career site — inject the generic ATS script
  console.log("AutoApply BG: Detected new tab for external apply:", tab.url);
  expectingNewTab = false;
  clearTimeout(expectingTimeout);

  // Wait a moment for the page to fully render, then inject
  setTimeout(() => {
    injectATSScript(tabId, tab.url);
  }, 3000);
});

/**
 * Inject the appropriate ATS script into a tab.
 * Falls back to generic.js if no specific ATS is detected.
 */
async function injectATSScript(tabId, url) {
  const urlLower = url.toLowerCase();

  let scriptFile = "ats/generic.js";
  if (urlLower.includes("greenhouse.io")) {
    scriptFile = "ats/greenhouse.js";
  } else if (urlLower.includes("lever.co")) {
    scriptFile = "ats/lever.js";
  } else if (urlLower.includes("myworkdayjobs.com")) {
    scriptFile = "ats/workday.js";
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptFile],
    });
    console.log(`AutoApply BG: Injected ${scriptFile} into tab ${tabId}`);
  } catch (err) {
    console.error("AutoApply BG: Failed to inject script:", err);
    // Try with generic as fallback
    if (scriptFile !== "ats/generic.js") {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["ats/generic.js"],
        });
        console.log("AutoApply BG: Injected generic.js as fallback");
      } catch (err2) {
        console.error("AutoApply BG: Generic fallback also failed:", err2);
      }
    }
  }
}

/**
 * Call the AutoApply API to tailor the resume for the given job.
 */
async function handleTailorAndFill(job) {
  const stored = await chrome.storage.local.get(["parsedResume", "autoapplyUrl", "userProfile"]);

  if (!stored.parsedResume) {
    throw new Error("No resume found. Upload your resume on the AutoApply pipeline page first.");
  }

  const apiUrl = stored.autoapplyUrl || "https://autoapply-ai-delta.vercel.app";
  console.log("AutoApply BG: Using API URL:", apiUrl);
  console.log("AutoApply BG: Has parsedResume:", !!stored.parsedResume);
  console.log("AutoApply BG: Has userProfile:", !!stored.userProfile);
  console.log("AutoApply BG: JD length:", job.jobDescription?.length || 0);

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

  // Step 1: Analyze the job description
  console.log("AutoApply BG: Step 1/3 — Analyzing JD for", job.jobTitle);
  let analyzeRes;
  try {
    analyzeRes = await fetch(`${apiUrl}/api/analyze-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription: job.jobDescription }),
    });
  } catch (fetchErr) {
    console.error("AutoApply BG: Network error on analyze-job:", fetchErr);
    throw new Error(`Network error calling analyze-job: ${fetchErr.message}`);
  }

  if (!analyzeRes.ok) {
    const errBody = await analyzeRes.text().catch(() => "");
    console.error("AutoApply BG: analyze-job failed:", analyzeRes.status, errBody);
    throw new Error(`Job analysis failed (${analyzeRes.status}): ${errBody.substring(0, 100)}`);
  }

  const analyzeData = await analyzeRes.json();
  // API returns { parsedJob: { title, company, ... } }
  const parsedJob = analyzeData.parsedJob || analyzeData;
  console.log("AutoApply BG: Step 1 done. Parsed job title:", parsedJob.title || parsedJob.jobTitle);

  // Step 2: Tailor the resume
  console.log("AutoApply BG: Step 2/3 — Tailoring resume for", job.jobTitle);
  let tailorRes;
  try {
    tailorRes = await fetch(`${apiUrl}/api/tailor-resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parsedResume: resumeForApi,
        parsedJob,
        mode: "fast",
      }),
    });
  } catch (fetchErr) {
    console.error("AutoApply BG: Network error on tailor-resume:", fetchErr);
    throw new Error(`Network error calling tailor-resume: ${fetchErr.message}`);
  }

  if (!tailorRes.ok) {
    const errBody = await tailorRes.text().catch(() => "");
    console.error("AutoApply BG: tailor-resume failed:", tailorRes.status, errBody);
    throw new Error(`Resume tailoring failed (${tailorRes.status}): ${errBody.substring(0, 100)}`);
  }

  const tailorData = await tailorRes.json();
  // API returns { tailoredResult: { matchScore, tailoredResume, coverLetter, ... } }
  const tailoredResult = tailorData.tailoredResult || tailorData;
  console.log("AutoApply BG: Step 2 done. Match score:", tailoredResult.matchScore);

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
      const jobNumData = await chrome.storage.local.get(["_aa_currentJobNumber"]);
      const jobNum = jobNumData._aa_currentJobNumber || "";
      const locationPart = job.location ? `_${job.location.split(",")[0].trim()}` : "";
      const prefix = jobNum ? `${jobNum}_` : "";
      await chrome.storage.local.set({
        tailoredResumePdf: base64,
        tailoredResumeFilename: `${prefix}${job.company}${locationPart}_${job.jobTitle}_Resume.pdf`,
      });
      console.log("AutoApply BG: Step 3 done. PDF generated.");
    } else {
      const errBody = await pdfRes.text().catch(() => "");
      console.warn(`AutoApply BG: PDF export failed: ${pdfRes.status} — ${errBody.substring(0, 200)}`);
    }
  } catch (pdfErr) {
    console.warn("AutoApply BG: PDF export error:", pdfErr, "— continuing without PDF");
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

/* ── Extension Install ── */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    autoapplyUrl: "https://autoapply-ai-delta.vercel.app",
  });
});
