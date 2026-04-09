// popup.js — handles Overview, Profile, Activity, and Chat tabs

const AUTOAPPLY_URL = "https://autoapply-ai-delta.vercel.app";
const CHAT_API_URL  = AUTOAPPLY_URL + "/api/chat";
const LOG_STORAGE_KEY = "_aa_logs";

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initDashboard();
  initHistory();
  initProfile();
  initLogs();
  initPopupChat();
});

/* ─────────────── TAB MANAGEMENT ─────────────── */

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => {
        c.classList.remove("active");
        c.style.display = "none";
      });
      btn.classList.add("active");
      const tab = document.getElementById(tabName);
      if (tab) {
        tab.classList.add("active");
        tab.style.display = tabName === "chat" ? "flex" : "block";
      }
      if (tabName === "logs")    refreshLogs();
      if (tabName === "chat")    popupChatFocus();
      if (tabName === "history") refreshHistory();
    });
  });
  // Show the initially active tab correctly
  const activeTab = document.querySelector(".tab-content.active");
  if (activeTab) activeTab.style.display = "block";
}

/* ─────────────── OVERVIEW TAB ─────────────── */

function initDashboard() {
  const scrapedCount = document.getElementById("scraped-count");
  const sentCount    = document.getElementById("sent-count");
  const openBtn      = document.getElementById("open-pipeline");
  const clearBtn     = document.getElementById("clear-data");

  // Load session stats + all-time history count
  chrome.storage.local.get(["_aa_scrapedJobs", "completedApplications", "applicationHistory"], (result) => {
    const scraped  = Array.isArray(result._aa_scrapedJobs)        ? result._aa_scrapedJobs.length        : 0;
    const sent     = Array.isArray(result.completedApplications)  ? result.completedApplications.length  : 0;
    const allTime  = Array.isArray(result.applicationHistory)     ? result.applicationHistory.length     : 0;
    scrapedCount.textContent = scraped;
    sentCount.textContent    = sent;
    const appliedEl = document.getElementById("applied-total");
    if (appliedEl) appliedEl.textContent = allTime;
  });

  // Open the pipeline page in a new tab
  openBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: AUTOAPPLY_URL + "/pipeline" });
    window.close();
  });

  // Clear session data
  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear all jobs found this session?")) return;
    chrome.storage.local.remove(["_aa_scrapedJobs", "_aa_selectedIds", "completedApplications"], () => {
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
    ethnicity:     document.getElementById("ethnicity"),
    gender:        document.getElementById("gender"),
    disabilityStatus: document.getElementById("disabilityStatus"),
    veteranStatus: document.getElementById("veteranStatus"),
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
      ethnicity:          fields.ethnicity.value,
      gender:             fields.gender.value,
      disabilityStatus:   fields.disabilityStatus.value,
      veteranStatus:      fields.veteranStatus.value,
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
      ethnicity: "ethnicity", gender: "gender",
      disabilityStatus: "disabilityStatus", veteranStatus: "veteranStatus",
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

/* ─────────────── CHAT TAB ─────────────── */

let popupChatMessages = [];
let popupChatLoading  = false;

const POPUP_CHAT_SUGGESTIONS = [
  "What's this job about?",
  "Am I a good fit?",
  "What should I highlight?",
  "What's the salary range?",
];

function initPopupChat() {
  const input   = document.getElementById("popup-chat-input");
  const sendBtn = document.getElementById("popup-send-btn");
  const clearBtn = document.getElementById("popup-chat-clear");
  const openPageBtn = document.getElementById("popup-btn-open-page");

  if (!input) return;

  input.addEventListener("input", () => {
    const hasText = input.value.trim().length > 0;
    sendBtn.disabled = !hasText || popupChatLoading;
    sendBtn.style.opacity = (!hasText || popupChatLoading) ? "0.4" : "1";
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 72) + "px";
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) popupSendMessage();
    }
  });

  sendBtn.addEventListener("click", popupSendMessage);

  clearBtn.addEventListener("click", () => {
    popupChatMessages = [];
    renderPopupChat();
  });

  openPageBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "AA_CHAT_OPEN" });
        window.close();
      }
    });
  });

  renderPopupChat();
}

function popupChatFocus() {
  setTimeout(() => document.getElementById("popup-chat-input")?.focus(), 50);
}

async function popupSendMessage() {
  const input = document.getElementById("popup-chat-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text || popupChatLoading) return;

  popupChatMessages.push({ role: "user", content: text, ts: new Date().toISOString() });
  input.value = "";
  input.style.height = "auto";

  const sendBtn = document.getElementById("popup-send-btn");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.4"; }

  renderPopupChat(true);

  popupChatLoading = true;

  // Get page context from active tab
  let pageContext = {};
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      pageContext.url   = tab.url;
      pageContext.title = tab.title;
      // Inject a quick script to grab visible text
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const els = document.querySelectorAll("h1,h2,h3,p,li,td,article,[role='main']");
            return Array.from(els)
              .filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              })
              .map(el => el.innerText?.trim())
              .filter(t => t && t.length > 20)
              .slice(0, 100)
              .join("\n")
              .slice(0, 5000);
          }
        });
        pageContext.text = results?.[0]?.result || "";
      } catch (_) { /* scripting permission may be unavailable on some pages */ }
    }
  } catch (_) {}

  try {
    const apiMessages = popupChatMessages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));

    const res = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: apiMessages, pageContext }),
    });

    const data = await res.json();
    const reply = res.ok ? (data.reply || "No response received.") : (data.error || "Something went wrong.");
    popupChatMessages.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
  } catch {
    popupChatMessages.push({ role: "assistant", content: "Connection error — check your internet and try again.", ts: new Date().toISOString() });
  } finally {
    popupChatLoading = false;
  }

  renderPopupChat();
  if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = "1"; }
}

function renderPopupChat(showTyping = false) {
  const container = document.getElementById("popup-chat-messages");
  const empty     = document.getElementById("popup-chat-empty");
  const chips     = document.getElementById("popup-chat-chips");
  if (!container) return;

  if (popupChatMessages.length === 0) {
    if (empty) empty.style.display = "flex";
    // Show suggestion chips
    if (chips) {
      chips.innerHTML = POPUP_CHAT_SUGGESTIONS.map(s =>
        `<button class="popup-chat-chip" style="
          font-size:11px; color:#4F46E5; background:#EEF2FF;
          border:1px solid #C7D2FE; border-radius:20px;
          padding:3px 9px; cursor:pointer; white-space:nowrap;
        " data-msg="${s}">${s}</button>`
      ).join("");

      chips.querySelectorAll(".popup-chat-chip").forEach(chip => {
        chip.addEventListener("click", () => {
          const input = document.getElementById("popup-chat-input");
          if (input) {
            input.value = chip.getAttribute("data-msg");
            input.dispatchEvent(new Event("input"));
            popupSendMessage();
          }
        });
      });
    }
    return;
  }

  if (empty) empty.style.display = "none";
  if (chips) chips.innerHTML = "";

  // Render messages (skip the empty placeholder div)
  const msgHtml = popupChatMessages.map(m => {
    const time = (m.ts || "").split("T")[1]?.slice(0, 5) || "";
    const content = m.content.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    const bubbleStyle = m.role === "user"
      ? "align-self:flex-end;background:#4F46E5;color:#fff;border-radius:12px 12px 4px 12px;"
      : "align-self:flex-start;background:#F3F4F6;color:#111827;border-radius:12px 12px 12px 4px;";
    return `
      <div style="max-width:90%;font-size:12px;line-height:1.5;padding:7px 11px;${bubbleStyle}word-break:break-word;">${content}</div>
      ${time ? `<div style="font-size:10px;color:#9CA3AF;${m.role === "user" ? "align-self:flex-end;" : "align-self:flex-start;"}">${time}</div>` : ""}
    `;
  }).join("");

  const typingHtml = showTyping ? `
    <div style="align-self:flex-start;background:#F3F4F6;border-radius:12px 12px 12px 4px;padding:8px 12px;display:flex;gap:4px;align-items:center;">
      <span style="width:5px;height:5px;border-radius:50%;background:#9CA3AF;animation:aa-popup-bounce 1.2s ease-in-out infinite;"></span>
      <span style="width:5px;height:5px;border-radius:50%;background:#9CA3AF;animation:aa-popup-bounce 1.2s ease-in-out 0.2s infinite;"></span>
      <span style="width:5px;height:5px;border-radius:50%;background:#9CA3AF;animation:aa-popup-bounce 1.2s ease-in-out 0.4s infinite;"></span>
    </div>
  ` : "";

  container.innerHTML = `
    <style>
      @keyframes aa-popup-bounce {
        0%,60%,100% { transform: translateY(0); }
        30% { transform: translateY(-4px); }
      }
    </style>
    <div style="display:flex;flex-direction:column;gap:5px;padding-top:4px;">
      ${msgHtml}${typingHtml}
    </div>
  `;

  container.scrollTop = container.scrollHeight;
}

/* ─────────────── HISTORY TAB ─────────────── */

let _historyCache = [];

function initHistory() {
  const searchInput = document.getElementById("hist-search");
  const exportBtn   = document.getElementById("hist-export");
  const clearBtn    = document.getElementById("hist-clear");

  searchInput?.addEventListener("input", () => renderHistoryList(_historyCache, searchInput.value));

  exportBtn?.addEventListener("click", () => exportHistoryCSV(_historyCache));

  clearBtn?.addEventListener("click", () => {
    if (!confirm("Clear all application history? This cannot be undone.")) return;
    chrome.storage.local.remove(["applicationHistory"], () => {
      _historyCache = [];
      renderHistoryStats([]);
      renderHistoryList([], "");
    });
  });
}

function refreshHistory() {
  chrome.storage.local.get(["applicationHistory"], (result) => {
    const history = Array.isArray(result.applicationHistory) ? result.applicationHistory : [];
    // Sort newest first
    _historyCache = history.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    renderHistoryStats(_historyCache);
    const q = document.getElementById("hist-search")?.value || "";
    renderHistoryList(_historyCache, q);
  });
}

function renderHistoryStats(history) {
  const total = history.length;
  const now   = new Date();
  const today = now.toDateString();
  const weekAgo = new Date(now - 7 * 86400000);
  const todayCount = history.filter(h => new Date(h.timestamp).toDateString() === today).length;
  const weekCount  = history.filter(h => new Date(h.timestamp) >= weekAgo).length;

  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el("hist-total", total);
  el("hist-today", todayCount);
  el("hist-week",  weekCount);
}

function renderHistoryList(history, query) {
  const list = document.getElementById("hist-list");
  if (!list) return;

  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? history.filter(h =>
        (h.company  || "").toLowerCase().includes(q) ||
        (h.jobTitle || "").toLowerCase().includes(q) ||
        (h.ats      || "").toLowerCase().includes(q))
    : history;

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-icon">${q ? "🔍" : "📋"}</div>
        <p>${q ? "No matches for "" + query + """ : "No applications recorded yet."}</p>
        ${!q ? '<p style="margin-top:4px;font-size:11px;">Applications are automatically tracked when AutoApply fills a form.</p>' : ""}
      </div>`;
    return;
  }

  const atsClass = (ats) => {
    if (!ats) return "generic";
    const a = ats.toLowerCase();
    if (a.includes("workday"))    return "workday";
    if (a.includes("greenhouse")) return "greenhouse";
    if (a.includes("lever"))      return "lever";
    if (a.includes("icims"))      return "icims";
    return "generic";
  };

  const fmtDate = (iso) => {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now - d;
      const diffMin = Math.floor(diffMs / 60000);
      const diffH   = Math.floor(diffMin / 60);
      const diffD   = Math.floor(diffH / 24);
      if (diffMin < 1)  return "just now";
      if (diffMin < 60) return `${diffMin}m ago`;
      if (diffH < 24)   return `${diffH}h ago`;
      if (diffD < 7)    return `${diffD}d ago`;
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch { return ""; }
  };

  list.innerHTML = filtered.slice(0, 100).map(h => {
    const cls   = atsClass(h.ats);
    const label = (h.ats || "").replace(/\.com$/, "").toLowerCase() || "generic";
    const jobUrl = h.jobUrl ? `href="${h.jobUrl}" target="_blank"` : "";
    return `
      <div class="history-item">
        <div class="history-item-top">
          <span class="history-item-role" title="${h.jobTitle || ""}">${h.jobTitle || "Untitled"}</span>
          <span class="history-item-date">${fmtDate(h.timestamp)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <span class="history-item-company">${h.company || "Unknown Company"}</span>
          <span class="history-badge ${cls}">${label}</span>
          ${h.jobUrl ? `<a ${jobUrl} style="font-size:10px;color:#4F46E5;margin-left:auto;text-decoration:none;" title="Open job posting">↗</a>` : ""}
        </div>
      </div>`;
  }).join("");
}

function exportHistoryCSV(history) {
  if (!history || history.length === 0) { alert("No history to export."); return; }
  const cols  = ["date", "company", "jobTitle", "ats", "status", "jobUrl"];
  const header = cols.join(",");
  const rows   = history.map(h => cols.map(k => {
    const v = (h[k === "date" ? "timestamp" : k] || "").toString().replace(/"/g, '""');
    return `"${v}"`;
  }).join(","));
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = `autoapply-history-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
