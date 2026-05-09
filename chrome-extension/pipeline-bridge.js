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
  // The new Console (/console) is the canonical capture surface going
  // forward — replaces the legacy /pipeline event-bus pattern. When the
  // user lands here, we POST any pendingJobs straight to /api/console/jobs
  // (auth cookie rides on same-origin credentials).
  const isConsole = path.includes("/console");

  if (!isPipeline && !isDashboard && !isConsole) return;

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
  chrome.storage.local.get(["pendingJobs"], async (result) => {
    const jobs = result.pendingJobs;
    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) return;

    console.log(`AutoApply Bridge: Found ${jobs.length} jobs from extension`);

    if (isConsole) {
      // New path: POST each job to /api/console/jobs. The Console UI's
      // existing GET /api/console/jobs poll will pick them up on its next
      // refresh tick, so no React event bus needed. Log per-job so the
      // user can debug failures from devtools.
      let posted = 0;
      let failed = 0;
      for (const job of jobs) {
        const url = job.jobUrl || job.url;
        if (!url) {
          console.warn("AutoApply Bridge: skipping job with no URL", job);
          continue;
        }
        try {
          const res = await fetch("/api/console/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              url,
              title: job.title || job.jobTitle || undefined,
              company: job.company || undefined,
              location: job.location || undefined,
              source: "extension",
              manualOnly: !!job.manualOnly,
            }),
          });
          if (res.ok) {
            posted++;
          } else {
            failed++;
            console.warn(`AutoApply Bridge: POST /api/console/jobs failed (${res.status}) for ${url}`);
          }
        } catch (e) {
          failed++;
          console.warn(`AutoApply Bridge: POST /api/console/jobs errored for ${url}:`, e);
        }
      }
      console.log(`AutoApply Bridge: imported ${posted}/${jobs.length} jobs to /api/console/jobs (${failed} failed)`);
    } else {
      // Legacy path: dispatch the event bus the /pipeline + /dashboard
      // pages still listen for. Kept until those pages are retired.
      localStorage.setItem("autoapply-extension-jobs", JSON.stringify(jobs));
      window.dispatchEvent(
        new CustomEvent("autoapply-extension-import", { detail: { jobs } })
      );
    }

    chrome.storage.local.remove(["pendingJobs"], () => {
      console.log("AutoApply Bridge: Cleared pending jobs from storage");
    });
  });

  /* ── LinkedIn Pull Trigger: Console page → Extension storage ──
     Page-side JS can't write chrome.storage from an isolated content-
     script world. So /console postMessages the trigger config and we
     (a content script in the page's content-script world) relay it
     into chrome.storage.local where linkedin-pull.js can read it on
     the next LinkedIn search page load. */
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.__aa_trigger !== "linkedin_pull") return;
    if (!data.cfg || typeof data.cfg !== "object") {
      console.warn("AutoApply Bridge: linkedin_pull trigger missing cfg");
      return;
    }
    chrome.storage.local.set({ _aa_pull_linkedin: data.cfg }, () => {
      console.log("AutoApply Bridge: stored LinkedIn pull trigger", data.cfg);
      // ACK the page so it can open the LinkedIn tab synchronously
      // (still inside the user's click gesture if the round-trip is fast).
      window.postMessage({ __aa_trigger_ack: "linkedin_pull" }, "*");
    });
  });

  /* ── Resume & Profile Sync: React App → Extension ── */
  window.addEventListener("autoapply-sync-resume", (event) => {
    const { parsedResume, userProfile } = event.detail || {};
    let pending = 0;

    function maybeAck() {
      pending--;
      if (pending === 0) {
        // Fire ACK back to the page so the dashboard button can show real confirmation
        window.dispatchEvent(new CustomEvent("autoapply-sync-ack", {
          detail: { ok: true, ts: Date.now() }
        }));
        console.log("AutoApply Bridge: Sync ACK sent to page");
      }
    }

    if (parsedResume) {
      pending++;
      chrome.storage.local.set({ parsedResume }, () => {
        console.log("AutoApply Bridge: Synced parsed resume to extension storage");
        maybeAck();
      });
    }

    if (userProfile) {
      pending++;
      chrome.storage.local.set({ userProfile }, () => {
        console.log("AutoApply Bridge: Synced user profile to extension storage");
        maybeAck();
      });
    }

    // Nothing to write — still ACK so button doesn't hang
    if (pending === 0) {
      window.dispatchEvent(new CustomEvent("autoapply-sync-ack", {
        detail: { ok: false, ts: Date.now() }
      }));
    }
  });

  // [BUG-001 fix 2026-04-16] Poll localStorage repeatedly for the first 20s
  // after load so we don't lose the profile/resume when the React app's
  // server fetch completes AFTER the bridge's listeners attach but before
  // its first localStorage read (race that used to leave Kiran's second
  // laptop showing Harshit's stale chrome.storage.local data).
  //
  // Also reads BOTH possible profile keys — "autoapply-user-profile" (legacy)
  // AND "aa_profile" (what the dashboard's UserStoreGuard writes). Either
  // one present means the profile is authoritative for this session.
  let lastProfileHash = "";
  let lastResumeHash = "";
  function readAndSync() {
    try {
      const storedResume = localStorage.getItem("autoapply-parsed-resume");
      const storedProfile =
        localStorage.getItem("autoapply-user-profile") ||
        localStorage.getItem("aa_profile");

      if (storedResume && storedResume !== lastResumeHash) {
        lastResumeHash = storedResume;
        chrome.storage.local.set({ parsedResume: JSON.parse(storedResume) }, () => {
          console.log("AutoApply Bridge: Synced resume from localStorage to extension");
        });
      }

      if (storedProfile && storedProfile !== lastProfileHash) {
        lastProfileHash = storedProfile;
        chrome.storage.local.set({ userProfile: JSON.parse(storedProfile) }, () => {
          console.log("AutoApply Bridge: Synced profile from localStorage to extension");
        });
      }
    } catch (e) {
      console.warn("AutoApply Bridge: Error reading localStorage", e);
    }
  }

  // Immediate read + poll every 1s for 20s to catch late writes from the
  // React fetch (`/api/user/profile`, `/api/user/resume`).
  readAndSync();
  let polls = 0;
  const pollInterval = setInterval(() => {
    readAndSync();
    if (++polls >= 20) clearInterval(pollInterval);
  }, 1000);

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

  /* ── Resume Map Sync: Extension → React App ── */
  // Sync metadata-only (no PDFs) so the dashboard can show Recent Resumes
  function syncResumeMap() {
    chrome.storage.local.get(["tailoredResumeMap"], (result) => {
      const map = result.tailoredResumeMap || {};
      const metadata = Object.entries(map).map(([key, entry]) => ({
        key,
        jobTitle:   entry.jobTitle   || "",
        company:    entry.company    || "",
        filename:   entry.filename   || "",
        matchScore: entry.matchScore || 0,
        jobUrl:     entry.jobUrl     || "",
        createdAt:  entry.createdAt  || 0,
      }));
      metadata.sort((a, b) => b.createdAt - a.createdAt);
      localStorage.setItem("autoapply-resume-map", JSON.stringify(metadata));
      window.dispatchEvent(new CustomEvent("autoapply-resume-map-sync", { detail: metadata }));
      console.log(`AutoApply Bridge: Synced ${metadata.length} resume entries to dashboard`);
    });
  }

  syncResumeMap();

  /* ── Download resume from dashboard: React → Extension ── */
  window.addEventListener("autoapply-download-resume", (e) => {
    const { key, job } = e.detail || {};
    if (!key) return;
    chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME_BY_KEY", key, job: job || {} }, () => {});
  });

  // Re-sync resume map whenever it changes (e.g. after a batch run completes)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.funnelStats) {
      const stats = changes.funnelStats.newValue || { opened: 0, formFilled: 0, resumeTailored: 0, completed: 0 };
      localStorage.setItem("autoapply-funnel-stats", JSON.stringify(stats));
      window.dispatchEvent(new CustomEvent("autoapply-funnel-sync", { detail: stats }));
    }
    if (area === "local" && changes.tailoredResumeMap) {
      syncResumeMap();
    }
  });
})();
