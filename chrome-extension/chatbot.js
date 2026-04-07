/**
 * AutoApply AI Chatbot — floating chat panel
 * Injected into every page. Opens when triggered from the extension popup
 * or by clicking the floating chat button.
 *
 * Features:
 * - Persistent chat window with conversation history
 * - Sends page context (URL, title, visible text) with every message
 * - "Point at element" mode — click any page element to add it to context
 * - Powered by /api/chat on the AutoApply backend
 */

(function () {
  "use strict";

  const AUTOAPPLY_URL = "https://autoapply-ai-delta.vercel.app";
  const CHAT_API_URL  = AUTOAPPLY_URL + "/api/chat";
  const PANEL_ID      = "aa-chat-panel";
  const BTN_ID        = "aa-chat-btn";

  // ── State ──────────────────────────────────────────────────────────────────
  let messages = [];          // { role, content, ts }[]
  let isOpen   = false;
  let isLoading = false;
  let inspectMode = false;    // "Point at element" mode
  let inspectedEl = null;     // Text from the pointed-at element
  let hoverTarget = null;     // Currently highlighted element

  // ── Styles injected once ───────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("aa-chat-styles")) return;
    const style = document.createElement("style");
    style.id = "aa-chat-styles";
    style.textContent = `
      #${BTN_ID} {
        position: fixed;
        bottom: 24px;
        left: 24px;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
        border: none;
        cursor: pointer;
        z-index: 2147483640;
        box-shadow: 0 4px 20px rgba(79,70,229,0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.15s, box-shadow 0.15s;
        pointer-events: auto;
      }
      #${BTN_ID}:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 28px rgba(79,70,229,0.5);
      }
      #${BTN_ID} svg {
        width: 22px;
        height: 22px;
        fill: #fff;
      }
      #${PANEL_ID} {
        position: fixed;
        bottom: 84px;
        left: 24px;
        width: 360px;
        max-height: 520px;
        min-height: 320px;
        background: #fff;
        border-radius: 16px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
        z-index: 2147483641;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        border: 1px solid rgba(79,70,229,0.12);
        animation: aa-chat-slide-up 0.2s ease;
      }
      @keyframes aa-chat-slide-up {
        from { opacity: 0; transform: translateY(12px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .aa-chat-header {
        background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
        padding: 12px 14px 11px;
        display: flex;
        align-items: center;
        gap: 9px;
        flex-shrink: 0;
      }
      .aa-chat-header-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #6EE7B7;
        box-shadow: 0 0 0 2px rgba(110,231,183,0.35);
      }
      .aa-chat-header-title {
        flex: 1;
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        letter-spacing: 0.1px;
      }
      .aa-chat-header-sub {
        font-size: 10px;
        color: rgba(255,255,255,0.65);
        font-weight: 400;
      }
      .aa-chat-header-close {
        background: rgba(255,255,255,0.15);
        border: none;
        border-radius: 6px;
        width: 24px;
        height: 24px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-size: 14px;
        transition: background 0.15s;
        flex-shrink: 0;
      }
      .aa-chat-header-close:hover { background: rgba(255,255,255,0.25); }
      .aa-messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px 12px 4px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        scroll-behavior: smooth;
      }
      .aa-messages::-webkit-scrollbar { width: 4px; }
      .aa-messages::-webkit-scrollbar-track { background: transparent; }
      .aa-messages::-webkit-scrollbar-thumb { background: #E5E7EB; border-radius: 2px; }
      .aa-msg {
        max-width: 88%;
        font-size: 13px;
        line-height: 1.5;
        padding: 8px 11px;
        border-radius: 12px;
        word-break: break-word;
      }
      .aa-msg.user {
        align-self: flex-end;
        background: #4F46E5;
        color: #fff;
        border-bottom-right-radius: 4px;
      }
      .aa-msg.assistant {
        align-self: flex-start;
        background: #F3F4F6;
        color: #111827;
        border-bottom-left-radius: 4px;
      }
      .aa-msg.assistant a { color: #4F46E5; }
      .aa-msg-time {
        font-size: 10px;
        color: #9CA3AF;
        margin: 1px 2px 0;
        align-self: flex-end;
      }
      .aa-msg-time.user { align-self: flex-end; }
      .aa-typing {
        align-self: flex-start;
        background: #F3F4F6;
        border-radius: 12px;
        border-bottom-left-radius: 4px;
        padding: 8px 14px;
        display: flex;
        gap: 4px;
        align-items: center;
      }
      .aa-typing span {
        width: 6px; height: 6px;
        background: #9CA3AF;
        border-radius: 50%;
        animation: aa-bounce 1.2s ease-in-out infinite;
      }
      .aa-typing span:nth-child(2) { animation-delay: 0.2s; }
      .aa-typing span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes aa-bounce {
        0%,60%,100% { transform: translateY(0); }
        30% { transform: translateY(-5px); }
      }
      .aa-empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 16px;
        text-align: center;
      }
      .aa-empty-icon { font-size: 32px; }
      .aa-empty-title { font-size: 13px; font-weight: 600; color: #374151; }
      .aa-empty-sub { font-size: 12px; color: #9CA3AF; }
      .aa-chips {
        padding: 0 10px 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        flex-shrink: 0;
      }
      .aa-chip {
        font-size: 11px;
        color: #4F46E5;
        background: #EEF2FF;
        border: 1px solid #C7D2FE;
        border-radius: 20px;
        padding: 3px 10px;
        cursor: pointer;
        transition: background 0.12s;
        white-space: nowrap;
      }
      .aa-chip:hover { background: #E0E7FF; }
      .aa-context-bar {
        margin: 0 10px 6px;
        background: #FFF7ED;
        border: 1px solid #FED7AA;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 11px;
        color: #92400E;
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .aa-context-bar-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .aa-context-bar-clear {
        cursor: pointer;
        font-size: 13px;
        color: #B45309;
        flex-shrink: 0;
      }
      .aa-toolbar {
        padding: 6px 10px;
        display: flex;
        align-items: center;
        gap: 5px;
        border-top: 1px solid #F3F4F6;
        flex-shrink: 0;
      }
      .aa-toolbar-btn {
        background: none;
        border: 1px solid #E5E7EB;
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 11px;
        color: #6B7280;
        cursor: pointer;
        transition: all 0.12s;
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .aa-toolbar-btn:hover { background: #F3F4F6; color: #374151; }
      .aa-toolbar-btn.active { background: #EEF2FF; border-color: #C7D2FE; color: #4F46E5; }
      .aa-input-row {
        padding: 8px 10px 10px;
        display: flex;
        gap: 6px;
        align-items: flex-end;
        flex-shrink: 0;
      }
      #aa-chat-input {
        flex: 1;
        border: 1px solid #E5E7EB;
        border-radius: 10px;
        padding: 7px 11px;
        font-size: 13px;
        font-family: inherit;
        color: #111827;
        background: #F9FAFB;
        outline: none;
        resize: none;
        max-height: 80px;
        min-height: 34px;
        overflow-y: auto;
        line-height: 1.4;
        transition: border-color 0.15s;
      }
      #aa-chat-input:focus { border-color: #A5B4FC; background: #fff; }
      #aa-chat-input::placeholder { color: #D1D5DB; }
      .aa-send-btn {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: #4F46E5;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.12s, opacity 0.12s;
      }
      .aa-send-btn:hover { background: #4338CA; }
      .aa-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .aa-send-btn svg { width: 15px; height: 15px; fill: #fff; }

      /* Inspect mode — highlight hovered elements */
      .aa-inspect-highlight {
        outline: 2px solid #4F46E5 !important;
        outline-offset: 2px !important;
        cursor: crosshair !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ── DOM builders ───────────────────────────────────────────────────────────
  function createButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.title = "AutoApply AI Assistant";
    btn.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l4.93-1.37C8.42 21.5 10.15 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm1 15H7v-2h6v2zm2-4H7v-2h8v2zm0-4H7V7h8v2z"/></svg>`;
    btn.addEventListener("click", togglePanel);
    document.body.appendChild(btn);
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="aa-chat-header">
        <div class="aa-chat-header-dot"></div>
        <div style="flex:1;">
          <div class="aa-chat-header-title">AI Assistant</div>
          <div class="aa-chat-header-sub" id="aa-page-label">Loading page info...</div>
        </div>
        <button class="aa-chat-header-close" id="aa-chat-close" title="Close">✕</button>
      </div>

      <div class="aa-messages" id="aa-messages"></div>

      <div class="aa-chips" id="aa-chips" style="display:none;"></div>

      <div class="aa-context-bar" id="aa-context-bar" style="display:none;">
        <span>📌</span>
        <span class="aa-context-bar-text" id="aa-context-text"></span>
        <span class="aa-context-bar-clear" id="aa-context-clear" title="Clear context">✕</span>
      </div>

      <div class="aa-toolbar">
        <button class="aa-toolbar-btn" id="aa-btn-inspect" title="Click any element on the page to add it as context">
          🎯 Point at element
        </button>
        <button class="aa-toolbar-btn" id="aa-btn-clear" title="Clear conversation">
          🗑 Clear
        </button>
      </div>

      <div class="aa-input-row">
        <textarea
          id="aa-chat-input"
          placeholder="Ask anything about this page..."
          rows="1"
        ></textarea>
        <button class="aa-send-btn" id="aa-send-btn" disabled>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    `;
    document.body.appendChild(panel);
    bindPanelEvents(panel);
    updatePageLabel();
  }

  function bindPanelEvents(panel) {
    panel.querySelector("#aa-chat-close").addEventListener("click", closePanel);
    panel.querySelector("#aa-btn-clear").addEventListener("click", clearChat);
    panel.querySelector("#aa-btn-inspect").addEventListener("click", toggleInspect);
    panel.querySelector("#aa-context-clear").addEventListener("click", clearContext);

    const input  = panel.querySelector("#aa-chat-input");
    const sendBtn = panel.querySelector("#aa-send-btn");

    input.addEventListener("input", () => {
      sendBtn.disabled = input.value.trim().length === 0 || isLoading;
      // Auto-grow
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 80) + "px";
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) sendMessage();
      }
    });

    sendBtn.addEventListener("click", sendMessage);
  }

  // ── Panel state ────────────────────────────────────────────────────────────
  function togglePanel() {
    isOpen ? closePanel() : openPanel();
  }

  function openPanel() {
    isOpen = true;
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.style.display = "flex";
      panel.style.flexDirection = "column";
      renderMessages();
      setTimeout(() => document.getElementById("aa-chat-input")?.focus(), 80);
    }
  }

  function closePanel() {
    isOpen = false;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = "none";
    exitInspectMode();
  }

  function clearChat() {
    messages = [];
    inspectedEl = null;
    renderMessages();
    updateContextBar();
  }

  // ── Page context ───────────────────────────────────────────────────────────
  function getPageContext() {
    const url   = window.location.href;
    const title = document.title;

    // Extract meaningful text from visible elements, skip boilerplate
    const selectors = "h1, h2, h3, p, li, td, [role='main'], article, section, .job-description, [data-testid], [class*='description'], [class*='content']";
    const els = Array.from(document.querySelectorAll(selectors));
    const texts = els
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !isInsidePanel(el);
      })
      .map(el => el.innerText?.trim())
      .filter(t => t && t.length > 20)
      .slice(0, 120);

    const text = [...new Set(texts)].join("\n").slice(0, 8000);

    return {
      url,
      title,
      text,
      selectedElement: inspectedEl || undefined,
    };
  }

  function isInsidePanel(el) {
    return !!el.closest(`#${PANEL_ID}`) || !!el.closest(`#${BTN_ID}`);
  }

  function updatePageLabel() {
    const label = document.getElementById("aa-page-label");
    if (label) {
      const hostname = (() => { try { return new URL(window.location.href).hostname.replace("www.", ""); } catch { return "this page"; } })();
      label.textContent = hostname;
    }
  }

  // ── Inspect mode ───────────────────────────────────────────────────────────
  function toggleInspect() {
    inspectMode ? exitInspectMode() : enterInspectMode();
  }

  function enterInspectMode() {
    inspectMode = true;
    const btn = document.getElementById("aa-btn-inspect");
    if (btn) { btn.classList.add("active"); btn.textContent = "🎯 Click an element..."; }

    // Highlight hovered elements
    document.addEventListener("mouseover", onInspectHover);
    document.addEventListener("click", onInspectClick, true);
    document.body.style.cursor = "crosshair";
  }

  function exitInspectMode() {
    inspectMode = false;
    const btn = document.getElementById("aa-btn-inspect");
    if (btn) { btn.classList.remove("active"); btn.textContent = "🎯 Point at element"; }

    if (hoverTarget) {
      hoverTarget.classList.remove("aa-inspect-highlight");
      hoverTarget = null;
    }

    document.removeEventListener("mouseover", onInspectHover);
    document.removeEventListener("click", onInspectClick, true);
    document.body.style.cursor = "";
  }

  function onInspectHover(e) {
    if (isInsidePanel(e.target)) return;
    if (hoverTarget && hoverTarget !== e.target) {
      hoverTarget.classList.remove("aa-inspect-highlight");
    }
    hoverTarget = e.target;
    hoverTarget.classList.add("aa-inspect-highlight");
  }

  function onInspectClick(e) {
    if (isInsidePanel(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    // Get semantic label for this element
    const text = el.innerText?.trim() || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.tagName.toLowerCase();
    const tag  = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const label = el.closest("label")?.innerText?.trim() || el.getAttribute("aria-label") || "";

    inspectedEl = `[${tag}${role ? " role=" + role : ""}${label ? " label='" + label + "'" : ""}]\n${text.slice(0, 400)}`;

    exitInspectMode();
    updateContextBar();

    // Focus input and pre-fill a hint
    const input = document.getElementById("aa-chat-input");
    if (input && !input.value.trim()) {
      input.placeholder = "Ask about this element...";
      input.focus();
    }
  }

  function clearContext() {
    inspectedEl = null;
    updateContextBar();
  }

  function updateContextBar() {
    const bar  = document.getElementById("aa-context-bar");
    const text = document.getElementById("aa-context-text");
    if (!bar || !text) return;
    if (inspectedEl) {
      bar.style.display = "flex";
      text.textContent  = inspectedEl.slice(0, 80) + (inspectedEl.length > 80 ? "…" : "");
    } else {
      bar.style.display = "none";
    }
  }

  // ── Messaging ──────────────────────────────────────────────────────────────
  async function sendMessage() {
    const input = document.getElementById("aa-chat-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text || isLoading) return;

    messages.push({ role: "user", content: text, ts: new Date().toISOString() });
    input.value = "";
    input.style.height = "auto";
    document.getElementById("aa-send-btn").disabled = true;

    const chips = document.getElementById("aa-chips");
    if (chips) chips.style.display = "none";

    renderMessages(true); // true = show typing indicator

    isLoading = true;

    try {
      const pageContext = getPageContext();
      const apiMessages = messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(CHAT_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, pageContext }),
      });

      const data = await res.json();
      const reply = res.ok ? (data.reply || "Sorry, I didn't get a response.") : (data.error || "Something went wrong.");

      messages.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
    } catch {
      messages.push({ role: "assistant", content: "Network error — check your connection and try again.", ts: new Date().toISOString() });
    } finally {
      isLoading = false;
    }

    renderMessages();
    document.getElementById("aa-send-btn").disabled = false;
  }

  function showSuggestions() {
    // Contextual suggestions based on the page
    const url = window.location.href;
    const chips = document.getElementById("aa-chips");
    if (!chips) return;

    let suggestions = [
      "What's this job about?",
      "Am I a good fit for this role?",
      "What should I highlight in my application?",
    ];

    if (url.includes("linkedin.com/jobs")) {
      suggestions = [
        "Summarize this job",
        "What skills are required?",
        "Is this role remote-friendly?",
        "What salary can I negotiate?",
      ];
    } else if (url.includes("greenhouse.io") || url.includes("lever.co") || url.includes("workday")) {
      suggestions = [
        "What is this form asking?",
        "Help me answer the open-ended questions",
        "What should I write for 'Why this company'?",
      ];
    }

    chips.innerHTML = suggestions.map(s =>
      `<button class="aa-chip" data-msg="${s}">${s}</button>`
    ).join("");
    chips.style.display = "flex";

    chips.querySelectorAll(".aa-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const input = document.getElementById("aa-chat-input");
        if (input) {
          input.value = chip.getAttribute("data-msg");
          input.dispatchEvent(new Event("input"));
          sendMessage();
        }
      });
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function renderMessages(showTyping = false) {
    const container = document.getElementById("aa-messages");
    if (!container) return;

    if (messages.length === 0) {
      container.innerHTML = `
        <div class="aa-empty-state">
          <div class="aa-empty-icon">💬</div>
          <div class="aa-empty-title">Ask me anything</div>
          <div class="aa-empty-sub">I can read this page and help you with your application.</div>
        </div>`;

      // Show suggestions after a tick
      setTimeout(showSuggestions, 50);
      return;
    }

    const chips = document.getElementById("aa-chips");
    if (chips) chips.style.display = "none";

    container.innerHTML = messages.map(m => {
      const time = (m.ts || "").split("T")[1]?.slice(0, 5) || "";
      const escaped = escapeHtml(m.content);
      // Convert plain URLs in assistant replies to links
      const content = m.role === "assistant"
        ? escaped.replace(/(https?:\/\/[^\s<>]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
        : escaped;
      return `
        <div class="aa-msg ${m.role}">${content}</div>
        ${time ? `<div class="aa-msg-time ${m.role}">${time}</div>` : ""}
      `;
    }).join("");

    if (showTyping) {
      container.innerHTML += `
        <div class="aa-typing" id="aa-typing">
          <span></span><span></span><span></span>
        </div>`;
    }

    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\n/g, "<br>");
  }

  // ── Listen for messages from background / popup ────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AA_CHAT_OPEN")  openPanel();
    if (msg.type === "AA_CHAT_CLOSE") closePanel();
    if (msg.type === "AA_CHAT_TOGGLE") togglePanel();
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  injectStyles();
  createButton();
  createPanel();
})();
