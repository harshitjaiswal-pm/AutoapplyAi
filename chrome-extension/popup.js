// Popup script — handles dashboard and profile tabs

document.addEventListener("DOMContentLoaded", () => {
  // Initialize tabs
  initTabs();

  // Initialize dashboard
  initDashboard();

  // Initialize profile
  initProfile();

  // Initialize logs
  initLogs();
});

/* ─────────────── LOGS TAB ─────────────── */

const LOG_STORAGE_KEY = "_aa_logs";

function initLogs() {
  document.getElementById("log-refresh").addEventListener("click", refreshLogs);
  document.getElementById("log-copy").addEventListener("click", copyLogs);
  document.getElementById("log-download").addEventListener("click", () => downloadLogs("json"));
  document.getElementById("log-download-md").addEventListener("click", () => downloadLogs("markdown"));
  document.getElementById("log-clear").addEventListener("click", () => {
    if (!confirm("Clear all captured logs?")) return;
    chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] }, refreshLogs);
  });

  // Auto-refresh whenever the Logs tab becomes active
  document.querySelector('[data-tab="logs"]').addEventListener("click", refreshLogs);
  refreshLogs();
}

function getLogs(cb) {
  chrome.storage.local.get([LOG_STORAGE_KEY], (result) => {
    cb(Array.isArray(result[LOG_STORAGE_KEY]) ? result[LOG_STORAGE_KEY] : []);
  });
}

function refreshLogs() {
  getLogs((entries) => {
    const total = entries.length;
    const errors = entries.filter((e) => e.category === "ERROR").length;
    const api = entries.filter((e) => e.category === "API").length;
    const form = entries.filter((e) => e.category === "FORM").length;

    document.getElementById("log-count").textContent = total;
    document.getElementById("log-error-count").textContent = errors;
    document.getElementById("log-api-count").textContent = api;
    document.getElementById("log-form-count").textContent = form;

    const preview = document.getElementById("log-preview");
    if (total === 0) {
      preview.textContent = "No logs yet. Start an apply run to capture events.";
      return;
    }
    // Show the last 25 entries as a compact trace
    const recent = entries.slice(-25);
    preview.textContent = recent
      .map((e) => {
        const t = (e.ts || "").split("T")[1]?.replace("Z", "") || "";
        return `[${t}] ${e.category.padEnd(6)} ${e.ctx} · ${e.stage}`;
      })
      .join("\n");
  });
}

function copyLogs() {
  getLogs((entries) => {
    const json = JSON.stringify(entries, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      const fb = document.getElementById("log-feedback");
      fb.textContent = `Copied ${entries.length} entries!`;
      fb.classList.add("show");
      setTimeout(() => fb.classList.remove("show"), 2000);
    }).catch((err) => {
      alert("Clipboard copy failed: " + err.message + "\n\nFall back to Download instead.");
    });
  });
}

function downloadLogs(format) {
  getLogs((entries) => {
    let content, mime, ext;
    if (format === "markdown") {
      const lines = [
        "# AutoApply debug log",
        `Exported: ${new Date().toISOString()}`,
        `Entries: ${entries.length}`,
        "",
      ];
      for (const e of entries) {
        lines.push(`## [${e.category}] ${e.stage}`);
        lines.push(`- ts: ${e.ts}`);
        lines.push(`- ctx: ${e.ctx}`);
        if (e.url) lines.push(`- url: ${e.url}`);
        lines.push("```json");
        try { lines.push(JSON.stringify(e.data, null, 2)); } catch (_) { lines.push("[unserialisable]"); }
        lines.push("```");
        lines.push("");
      }
      content = lines.join("\n");
      mime = "text/markdown";
      ext = "md";
    } else {
      content = JSON.stringify(entries, null, 2);
      mime = "application/json";
      ext = "json";
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    chrome.downloads.download({
      url,
      filename: `autoapply-logs-${stamp}.${ext}`,
      saveAs: true,
    }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  });
}

/* ─────────────── TAB MANAGEMENT ─────────────── */

function initTabs() {
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.getAttribute("data-tab");

      // Deactivate all tabs
      tabButtons.forEach((b) => b.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));

      // Activate selected tab
      btn.classList.add("active");
      document.getElementById(tabName).classList.add("active");
    });
  });
}

/* ─────────────── DASHBOARD TAB ─────────────── */

function initDashboard() {
  const urlInput = document.getElementById("url-input");
  const openBtn = document.getElementById("open-pipeline");
  const clearBtn = document.getElementById("clear-data");
  const scrapedCount = document.getElementById("scraped-count");
  const sentCount = document.getElementById("sent-count");

  // Load settings
  chrome.storage.local.get(
    ["autoapplyUrl", "scrapedJobs", "sentJobsCount"],
    (result) => {
      if (result.autoapplyUrl) {
        urlInput.value = result.autoapplyUrl;
      }
      scrapedCount.textContent = result.scrapedJobs?.length ?? 0;
      sentCount.textContent = result.sentJobsCount ?? 0;
    }
  );

  // Save URL on change
  urlInput.addEventListener("change", () => {
    chrome.storage.local.set({ autoapplyUrl: urlInput.value.trim() });
  });

  // Open Pipeline
  openBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (url) {
      chrome.tabs.create({ url: `${url}/pipeline` });
    } else {
      alert("Please enter your AutoApply URL first");
    }
  });

  // Clear data
  clearBtn.addEventListener("click", () => {
    if (confirm("Are you sure you want to clear all scraped jobs and stats?")) {
      chrome.storage.local.set({ scrapedJobs: [], sentJobsCount: 0 }, () => {
        scrapedCount.textContent = "0";
        sentCount.textContent = "0";
      });
    }
  });
}

/* ─────────────── PROFILE TAB ─────────────── */

function initProfile() {
  const profileFields = {
    firstName: document.getElementById("firstName"),
    lastName: document.getElementById("lastName"),
    email: document.getElementById("email"),
    phone: document.getElementById("phone"),
    address: document.getElementById("address"),
    city: document.getElementById("city"),
    province: document.getElementById("province"),
    postalCode: document.getElementById("postalCode"),
    linkedin: document.getElementById("linkedin"),
    github: document.getElementById("github"),
    portfolio: document.getElementById("portfolio"),
    currentCompany: document.getElementById("currentCompany"),
    pronouns: document.getElementById("pronouns"),
    workAuth: document.getElementById("workAuth"),
    howDidYouHear: document.getElementById("howDidYouHear"),
  };

  const saveBtn = document.getElementById("save-profile");
  const saveFeedback = document.getElementById("save-feedback");

  // Load existing profile on open
  loadProfile(profileFields);

  // Save profile on button click
  saveBtn.addEventListener("click", () => {
    saveProfile(profileFields, saveFeedback);
  });
}

function loadProfile(fields) {
  chrome.storage.local.get(["userProfile"], (result) => {
    const profile = result.userProfile || {};

    // Map stored field names to input IDs
    const fieldMap = {
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      phone: "phone",
      address: "address",
      city: "city",
      province: "province",
      postalCode: "postalCode",
      linkedin: "linkedin",
      github: "github",
      portfolio: "portfolio",
      currentCompany: "currentCompany",
      pronouns: "pronouns",
      requireSponsorship: "workAuth", // Note: different name in storage vs UI
      howDidYouHear: "howDidYouHear",
    };

    // Fill in stored values
    for (const [storageKey, fieldId] of Object.entries(fieldMap)) {
      const field = fields[fieldId];
      if (field && profile[storageKey]) {
        field.value = profile[storageKey];
      }
    }
  });
}

function saveProfile(fields, feedback) {
  const profile = {
    firstName: fields.firstName.value.trim(),
    lastName: fields.lastName.value.trim(),
    email: fields.email.value.trim(),
    phone: fields.phone.value.trim(),
    address: fields.address.value.trim(),
    city: fields.city.value.trim(),
    province: fields.province.value.trim(),
    postalCode: fields.postalCode.value.trim(),
    linkedin: fields.linkedin.value.trim(),
    github: fields.github.value.trim(),
    portfolio: fields.portfolio.value.trim(),
    currentCompany: fields.currentCompany.value.trim(),
    pronouns: fields.pronouns.value,
    requireSponsorship: fields.workAuth.value,
    howDidYouHear: fields.howDidYouHear.value,
  };

  // Validate minimum required fields
  if (!profile.firstName || !profile.email) {
    alert("Please fill in at least First Name and Email");
    return;
  }

  // Save to chrome.storage.local
  chrome.storage.local.set({ userProfile: profile }, () => {
    console.log("AutoApply: Profile saved", profile);

    // Show feedback
    feedback.classList.add("show");
    setTimeout(() => {
      feedback.classList.remove("show");
    }, 2000);
  });
}
