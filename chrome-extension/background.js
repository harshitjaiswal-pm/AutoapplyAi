/**
 * BACKGROUND SERVICE WORKER
 *
 * Stores jobs from the LinkedIn content script into chrome.storage.local,
 * then opens the pipeline page. The pipeline-bridge.js content script
 * (running on the pipeline page) reads the jobs and injects them.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_JOBS_TO_PIPELINE") {
    const { jobs, url } = message;

    // Store jobs for the pipeline bridge to pick up
    chrome.storage.local.set({ pendingJobs: jobs }, () => {
      // Open the pipeline page — pipeline-bridge.js will handle the rest
      chrome.tabs.create({ url: `${url}/pipeline?fromExtension=true` });
      sendResponse({ success: true });
    });

    return true; // Keep channel open for async response
  }

  if (message.type === "JOBS_SCRAPED") {
    chrome.storage.local.set({ scrapedJobs: message.jobs }, () => {
      sendResponse({ success: true, count: message.jobs.length });
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    autoapplyUrl: "https://autoapply-ai-delta.vercel.app",
    scrapedJobs: [],
  });
});
