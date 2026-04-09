// Syncs user profile from web app localStorage to Chrome extension storage
(function syncProfile() {
  try {
    const raw = window.localStorage.getItem("aa_profile");
    if (!raw) return;

    const profile = JSON.parse(raw);
    if (!profile || !profile.email) return;

    // Send to extension storage via chrome.storage API
    chrome.storage.local.set({ userProfile: profile }, function() {
      if (chrome.runtime.lastError) {
        console.error("AutoApply: Profile sync error:", chrome.runtime.lastError);
        return;
      }
      console.log("AutoApply: Profile synced from web app to extension storage ✓");
      // Clean up after successful sync
      window.localStorage.removeItem("aa_profile");
    });
  } catch (e) {
    console.error("AutoApply: Profile sync exception:", e);
  }
})();
