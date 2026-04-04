/**
 * BACKGROUND SERVICE WORKER
 *
 * Handles the bridge between content script (LinkedIn) and the AutoApply web app.
 * Uses chrome.scripting.executeScript to inject jobs into the pipeline page's localStorage.
 */

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_JOBS_TO_PIPELINE") {
    const { jobs, url } = message;

    // 1. Open the pipeline page
    chrome.tabs.create({ url: `${url}/pipeline?fromExtension=true` }, (tab) => {
      const tabId = tab.id;

      // 2. Wait for the page to finish loading, then inject jobs into localStorage
      chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);

          // 3. Inject the jobs data into the page's localStorage
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (jobsJson) => {
              try {
                localStorage.setItem("autoapply-extension-jobs", jobsJson);
                // Dispatch a custom event so the React app can pick it up
                window.dispatchEvent(new CustomEvent("autoapply-extension-import", {
                  detail: { jobs: JSON.parse(jobsJson) }
                }));
              } catch (e) {
                console.error("AutoApply: Failed to inject jobs", e);
              }
            },
            args: [JSON.stringify(jobs)],
          });
        }
      });
    });

    sendResponse({ success: true });
    return true;
  }

  if (message.type === "JOBS_SCRAPED") {
    chrome.storage.local.set({ scrapedJobs: message.jobs }, () => {
      sendResponse({ success: true, count: message.jobs.length });
    });
    return true;
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    autoapplyUrl: "https://autoapply-ai-delta.vercel.app",
    scrapedJobs: [],
  });
});
