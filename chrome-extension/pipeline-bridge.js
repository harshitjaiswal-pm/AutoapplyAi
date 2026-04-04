/**
 * PIPELINE BRIDGE — Content script that runs on the AutoApply pipeline page.
 *
 * Two jobs:
 * 1. Reads pending jobs from chrome.storage.local → injects into localStorage for React
 * 2. Listens for resume/profile sync events from the React app → stores in chrome.storage
 */

(() => {
  const path = window.location.pathname;
  const isPipeline = path.includes("/pipeline");
  const isDashboard = path.includes("/dashboard");

  if (!isPipeline && !isDashboard) return;

  /* ── Job Import: Extension → React App ── */
  chrome.storage.local.get(["pendingJobs"], (result) => {
    const jobs = result.pendingJobs;
    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) return;

    console.log(`AutoApply Bridge: Found ${jobs.length} jobs from extension`);
    localStorage.setItem("autoapply-extension-jobs", JSON.stringify(jobs));

    window.dispatchEvent(
      new CustomEvent("autoapply-extension-import", { detail: { jobs } })
    );

    chrome.storage.local.remove(["pendingJobs"], () => {
      console.log("AutoApply Bridge: Cleared pending jobs from storage");
    });
  });

  /* ── Resume & Profile Sync: React App → Extension ── */
  window.addEventListener("autoapply-sync-resume", (event) => {
    const { parsedResume, userProfile } = event.detail || {};

    if (parsedResume) {
      chrome.storage.local.set({ parsedResume }, () => {
        console.log("AutoApply Bridge: Synced parsed resume to extension storage");
      });
    }

    if (userProfile) {
      chrome.storage.local.set({ userProfile }, () => {
        console.log("AutoApply Bridge: Synced user profile to extension storage");
      });
    }
  });

  // Also check localStorage on load in case user synced before bridge loaded
  try {
    const storedResume = localStorage.getItem("autoapply-parsed-resume");
    const storedProfile = localStorage.getItem("autoapply-user-profile");

    if (storedResume) {
      chrome.storage.local.set({ parsedResume: JSON.parse(storedResume) }, () => {
        console.log("AutoApply Bridge: Synced resume from localStorage to extension");
      });
    }

    if (storedProfile) {
      chrome.storage.local.set({ userProfile: JSON.parse(storedProfile) }, () => {
        console.log("AutoApply Bridge: Synced profile from localStorage to extension");
      });
    }
  } catch (e) {
    console.warn("AutoApply Bridge: Error reading localStorage", e);
  }

  /* ── Completed Applications Sync: Extension → React App ── */
  // Sync completed applications from the extension to the dashboard
  chrome.storage.local.get(["completedApplications"], (result) => {
    const completed = result.completedApplications;
    if (!completed || !Array.isArray(completed) || completed.length === 0) return;

    console.log(`AutoApply Bridge: Found ${completed.length} completed applications`);
    localStorage.setItem("autoapply-completed-applications", JSON.stringify(completed));

    window.dispatchEvent(
      new CustomEvent("autoapply-completed-sync", { detail: { applications: completed } })
    );
  });
})();
