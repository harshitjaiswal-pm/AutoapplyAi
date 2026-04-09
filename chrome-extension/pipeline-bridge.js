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

  /* ── QA Test Helper: Allow page to override autoapplyUrl for API failure testing ── */
  // If localStorage has 'autoapply-test-api-url', write it into chrome.storage so
  // background.js picks up the (possibly broken) URL on the next API call.
  // Set to empty string to restore the default URL.
  try {
    const testUrl = localStorage.getItem("autoapply-test-api-url");
    if (testUrl !== null) {
      if (testUrl === "") {
        chrome.storage.local.remove(["autoapplyUrl"], () => {
          console.log("AutoApply Bridge: Removed test API URL override — using default");
        });
      } else {
        chrome.storage.local.set({ autoapplyUrl: testUrl }, () => {
          console.log("AutoApply Bridge: Set test API URL:", testUrl);
        });
      }
    }
  } catch(e) {
    console.warn("AutoApply Bridge: Error setting test URL", e);
  }

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

  /* ── Funnel Stats Sync: Extension → React App ── */
  // Sync 4-stage funnel stats so the dashboard can display real conversion data
  function syncFunnelStats() {
    chrome.storage.local.get(["funnelStats"], (result) => {
      const stats = result.funnelStats || { opened: 0, formFilled: 0, resumeTailored: 0, completed: 0 };
      localStorage.setItem("autoapply-funnel-stats", JSON.stringify(stats));
      window.dispatchEvent(new CustomEvent("autoapply-funnel-sync", { detail: stats }));
      console.log("AutoApply Bridge: Funnel stats synced", stats);
    });
  }

  syncFunnelStats();

  // Re-sync whenever funnelStats changes in chrome.storage (real-time updates)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.funnelStats) {
      const stats = changes.funnelStats.newValue || { opened: 0, formFilled: 0, resumeTailored: 0, completed: 0 };
      localStorage.setItem("autoapply-funnel-stats", JSON.stringify(stats));
      window.dispatchEvent(new CustomEvent("autoapply-funnel-sync", { detail: stats }));
    }
  });
})();
