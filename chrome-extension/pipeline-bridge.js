/**
 * PIPELINE BRIDGE — Content script that runs on the AutoApply pipeline page.
 *
 * Reads pending jobs from chrome.storage.local (put there by the LinkedIn content script)
 * and injects them into the page's localStorage so the React app can pick them up.
 */

(() => {
  // Only run on pipeline pages
  if (!window.location.pathname.includes("/pipeline")) return;

  // Check for pending jobs from the extension
  chrome.storage.local.get(["pendingJobs"], (result) => {
    const jobs = result.pendingJobs;
    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) return;

    console.log(`AutoApply Bridge: Found ${jobs.length} jobs from extension`);

    // Write to localStorage for the React app to read
    localStorage.setItem("autoapply-extension-jobs", JSON.stringify(jobs));

    // Dispatch custom event so the React app picks it up immediately
    window.dispatchEvent(
      new CustomEvent("autoapply-extension-import", {
        detail: { jobs },
      })
    );

    // Clear the pending jobs so they don't get imported again
    chrome.storage.local.remove(["pendingJobs"], () => {
      console.log("AutoApply Bridge: Cleared pending jobs from storage");
    });
  });
})();
