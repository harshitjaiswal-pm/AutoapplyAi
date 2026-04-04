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

  /* ── Legacy: pipeline bridge support ── */
  if (message.type === "SEND_JOBS_TO_PIPELINE") {
    const { jobs, url } = message;
    chrome.storage.local.set({ pendingJobs: jobs }, () => {
      chrome.tabs.create({ url: `${url}/pipeline?fromExtension=true` });
      sendResponse({ success: true });
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
        parsedResume: stored.parsedResume,
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
      const blob = await pdfRes.blob();
      resumeBlobUrl = URL.createObjectURL(blob);

      const arrayBuffer = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      await chrome.storage.local.set({
        tailoredResumePdf: base64,
        tailoredResumeFilename: `${job.company}_${job.jobTitle}_Resume.pdf`,
      });
      console.log("AutoApply BG: Step 3 done. PDF generated.");
    } else {
      console.warn("AutoApply BG: PDF export failed:", pdfRes.status, "— continuing without PDF");
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

  const byteCharacters = atob(stored.tailoredResumePdf);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

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
