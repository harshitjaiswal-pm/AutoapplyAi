/**
 * BACKGROUND SERVICE WORKER
 *
 * Handles communication between the content script and the AutoApply app.
 * Also manages chrome.storage for persisting scraped jobs.
 */

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "JOBS_SCRAPED") {
    // Store scraped jobs
    chrome.storage.local.set({ scrapedJobs: message.jobs }, () => {
      sendResponse({ success: true, count: message.jobs.length });
    });
    return true; // Keep message channel open for async response
  }

  if (message.type === "GET_SCRAPED_JOBS") {
    chrome.storage.local.get(["scrapedJobs"], (result) => {
      sendResponse({ jobs: result.scrapedJobs || [] });
    });
    return true;
  }

  if (message.type === "CLEAR_SCRAPED_JOBS") {
    chrome.storage.local.remove(["scrapedJobs", "pendingJobs"], () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// When extension is installed, set default settings
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    autoapplyUrl: "https://autoapply-ai-delta.vercel.app",
    scrapedJobs: [],
  });
});
