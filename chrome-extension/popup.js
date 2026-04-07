// popup.js — handles Overview, Profile, and Activity tabs

const AUTOAPPLY_URL = "https://autoapply-ai-delta.vercel.app";
const LOG_STORAGE_KEY = "_aa_logs";

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initDashboard();
  initProfile();
  initLogs();
});

/* ─────────────── TAB MANAGEMENT ─────────────── */

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(tabName).classList.add("active");
      if (tabName === "logs") refreshLogs();
    });
  });
}

/* ─────────────── OVERVIEW TAB ─────────────── */

function initDashboard() {
  const scrapedCount = document.getElementById("scraped-count");
  const sentCount    = document.getElementById("sent-count");
  const openBtn      = document.getElementById("open-pipeline");
  const clearBtn     = document.getElementById("clear-data");

  // Load session stats
  chrome.storage.local.get(["_aa_scrapedJobs", "sentJobsCount"], (result) => {
    const scraped = Array.isArray(result._aa_scrapedJobs) ? result._aa_scrapedJobs.length : 0;
    scrapedCount.textContent = scraped;
    sentCount.textContent    = result.sentJobsCount ?? 0;
  });

  // Open the pipeline page in a new tab
  openBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: AUTOAPPLY_URL + "/pipeline" });
    window.close();
  });

  // Clear session data
  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear all jobs found this session?")) return;
    chrome.storage.local.remove(["_aa_scrapedJobs", "_aa_selectedIds", "sentJobsCount"], () => {
      scrapedCount.textContent = "0";
      sentCount.textContent    = "0";
    });
  });
}

/* ─────────────── PROFILE TAB ─────────────── */

function initProfile() {
  const fields = {
    firstName:     document.getElementById("firstName"),
    lastName:      document.getElementById("lastName"),
    email:         document.getElementById("email"),
    phone:         document.getElementById("phone"),
    address:       document.getElementById("address"),
    city:          document.getElementById("city"),
    province:      document.getElementById("province"),
    postalCode:    document.getElementById("postalCode"),
    linkedin:      document.getElementById("linkedin"),
    github:        document.getElementById("github"),
    portfolio:     document.getElementById("portfolio"),
    currentCompany:document.getElementById("currentCompany"),
    pronouns:      document.getElementById("pronouns"),
    workAuth:      document.getElementById("workAuth"),
    howDidYouHear: document.getElementById("howDidYouHear"),
  };

  const saveBtn  = document.getElementById("save-profile");
  const feedback = document.getElementById("save-feedback");

  loadProfile(fields);

  saveBtn.addEventListener("click", () => {
    const profile = {
      firstName:          fields.firstName.value.trim(),
      lastName:           fields.lastName.value.trim(),
      email:              fields.email.value.trim(),
      phone:              fields.phone.value.trim(),
      address:            fields.address.value.trim(),
      city:               fields.city.value.trim(),
      province:           fields.province.value.trim(),
      postalCode:         fields.postalCode.value.trim(),
      linkedin:           fields.linkedin.value.trim(),
      github:             fields.github.value.trim(),
      portfolio:          fields.portfolio.value.trim(),
      currentCompany:     fields.currentCompany.value.trim(),
      pronouns:           fields.pronouns.value,
      requireSponsorship: fields.workAuth.value,
      howDidYouHear:      fields.howDidYouHear.value,
    };

    if (!profile.firstName || !profile.email) {
      alert("Please fill in at least your First Name and Email.");
      return;
    }

    chrome.storage.local.set({ userProfile: profile }, () => {
      feedback.classList.add("show");
      setTimeout(() => feedback.classList.remove("show"), 2500);
    });
  });
}

function loadProfile(fields) {
  chrome.storage.local.get(["userProfile"], (result) => {
    const p = result.userProfile || {};
    const map = {
      firstName: "firstName", lastName: "lastName", email: "email",
      phone: "phone", address: "address", city: "city",
      province: "province", postalCode: "postalCode",
      linkedin: "linkedin", github: "github", portfolio: "portfolio",
      currentCompany: "currentCompany", pronouns: "pronouns",
      requireSponsorship: "workAuth", howDidYouHear: "howDidYouHear",
    };
    for (const [key, fieldId] of Object.entries(map)) {
      if (fields[fieldId] && p[key]) fields[fieldId].value = p[key];
    }
  });
}

/* ─────────────── ACTIVITY TAB ─────────────── */

/** Map internal log categories to human-readable messages */
function humanizeLogEntry(entry) {
  const stage = entry.stage || "";
  const data  = entry.data  || {};

  // Key events users care about
  if (stage.includes("form.fill.done"))       return { type: "success", msg: `Filled form — ${data.filled ?? "?"} fields` };
  if (stage.includes("form.fill.start"))      return { type: "info",    msg: `Starting to fill form on ${shortHost(entry.url)}` };
  if (stage.includes("resume.upload.success"))return { type: "success", msg: "Resume uploaded successfully" };
  if (stage.includes("resume.upload.fail"))   return { type: "error",   msg: "Resume upload failed — download link shown" };
  if (stage.includes("ats.generic.loaded"))   return { type: "info",    msg: `Opened application: ${shortHost(entry.url)}` };
  if (stage.includes("ats.loaded"))           return { type: "info",    msg: `Application page ready: ${shortHost(entry.url)}` };
  if (stage.includes("ats.detect.signInWall"))return { type: "warn",    msg: "Sign-in required on this page" };
  if (stage.includes("batch.start"))          return { type: "info",    msg: `Starting batch — ${data.total ?? "?"} jobs` };
  if (stage.includes("batch.jobStart"))       return { type: "info",    msg: `Processing job ${data.jobNumber ?? "?"}/${data.total ?? "?"}` };
  if (stage.includes("linkedin.jd.scraped"))  return { type: "info",    msg: `Job description found (${data.jdLen ?? 0} chars)` };
  if (stage.includes("linkedin.clickApply"))  return { type: "info",    msg: "Opening application page…" };
  if (stage.includes("linkedin.apply.result"))return { type: "info",    msg: `Apply result: ${data.applyType ?? "unknown"}` };
  if (stage.includes("tailoring.done"))       return { type: "success", msg: `Resume tailored — match score ${data.matchScore ?? "?"}%` };
  if (stage.includes("tailoring.start"))      return { type: "info",    msg: "Tailoring resume for this role…" };
  if (entry.category === "ERROR")             return { type: "error",   msg: `Error: ${stage}` };
  if (entry.category === "API")               return { type: "info",    msg: `AI request: ${stage}` };
  return null; // skip low-level entries
}

function shortHost(url) {
  try { return new URL(url || "").hostname.replace("www.", ""); } catch { return url || ""; }
}

function initLogs() {
  const showRaw = document.getElementById("log-show-raw");

  document.getElementById("log-refresh").addEventListener("click", refreshLogs);
  document.getElementById("log-copy").addEventListener("click", copyLogs);
  document.getElementById("log-download-md").addEventListener("click", () => downloadLogs("markdown"));
  document.getElementById("log-clear").addEventListener("click", () => {
    if (!confirm("Clear all activity logs?")) return;
    chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] }, refreshLogs);
  });

  showRaw.addEventListener("change", () => {
    document.getElementById("log-raw-panel").style.display = showRaw.checked ? "block" : "none";
  });

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
    const total  = entries.length;
    const errors = entries.filter((e) => e.category === "ERROR").length;
    const forms  = entries.filter((e) => e.stage?.includes("form.fill")).length;

    document.getElementById("log-count").textContent      = total;
    document.getElementById("log-error-count").textContent = errors;
    document.getElementById("log-form-count").textContent  = forms;

    // Human-readable feed
    const feed = document.getElementById("log-feed");
    const humanEntries = entries
      .slice(-100)
      .reverse()
      .map((e) => ({ ...humanizeLogEntry(e), ts: e.ts }))
      .filter(Boolean)
      .slice(0, 30);

    if (humanEntries.length === 0) {
      feed.innerHTML = `<div class="log-entry">
        <div class="log-entry-dot info"></div>
        <div><div class="log-entry-msg">No activity yet — start an apply run to see events here.</div></div>
      </div>`;
    } else {
      feed.innerHTML = humanEntries.map((e) => {
        const time = (e.ts || "").split("T")[1]?.slice(0, 5) || "";
        return `<div class="log-entry">
          <div class="log-entry-dot ${e.type || "info"}"></div>
          <div style="flex:1;">
            <div class="log-entry-msg">${e.msg}</div>
            ${time ? `<div class="log-entry-time">${time}</div>` : ""}
          </div>
        </div>`;
      }).join("");
    }

    // Raw panel (hidden by default)
    const raw = document.getElementById("log-preview");
    if (total === 0) {
      raw.textContent = "No logs yet.";
    } else {
      const recent = entries.slice(-30);
      raw.textContent = recent.map((e) => {
        const t = (e.ts || "").split("T")[1]?.replace("Z","") || "";
        return `[${t}] ${(e.category||"").padEnd(6)} ${e.ctx||""} · ${e.stage||""}`;
      }).join("\n");
    }
  });
}

function copyLogs() {
  getLogs((entries) => {
    navigator.clipboard.writeText(JSON.stringify(entries, null, 2)).then(() => {
      const fb = document.getElementById("log-feedback");
      fb.textContent = `✓ Copied ${entries.length} log entries`;
      fb.classList.add("show");
      setTimeout(() => fb.classList.remove("show"), 2500);
    }).catch(() => alert("Clipboard copy failed — try Download instead."));
  });
}

function downloadLogs(format) {
  getLogs((entries) => {
    let content, mime, ext;
    if (format === "markdown") {
      const lines = [
        "# AutoApply Activity Report",
        `Exported: ${new Date().toISOString()}`,
        `Total events: ${entries.length}`,
        "",
      ];
      for (const e of entries) {
        lines.push(`## [${e.category}] ${e.stage}`);
        lines.push(`- Time: ${e.ts}`);
        if (e.url) lines.push(`- URL: ${e.url}`);
        lines.push("```json");
        try { lines.push(JSON.stringify(e.data, null, 2)); } catch { lines.push("[unserialisable]"); }
        lines.push("```\n");
      }
      content = lines.join("\n"); mime = "text/markdown"; ext = "md";
    } else {
      content = JSON.stringify(entries, null, 2); mime = "application/json"; ext = "json";
    }
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    chrome.downloads.download({ url, filename: `autoapply-report-${stamp}.${ext}`, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  });
}
