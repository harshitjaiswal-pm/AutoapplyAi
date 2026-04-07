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
      /* ── Chat button ── */
      #${BTN_ID} {
        all: initial !important;
        position: fixed !important;
        bottom: 24px !important; left: 24px !important;
        width: 48px !important; height: 48px !important;
        border-radius: 50% !important;
        background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%) !important;
        border: none !important; cursor: pointer !important;
        z-index: 2147483640 !important;
        box-shadow: 0 4px 20px rgba(79,70,229,0.4) !important;
        display: flex !important; align-items: center !important; justify-content: center !important;
        transition: transform 0.15s, box-shadow 0.15s !important;
        box-sizing: border-box !important;
      }
      #${BTN_ID}:hover { transform: scale(1.08) !important; box-shadow: 0 6px 28px rgba(79,70,229,0.5) !important; }
      #${BTN_ID} svg { width: 22px !important; height: 22px !important; fill: #fff !important; }

      /* ── Panel shell ── */
      #${PANEL_ID} {
        all: initial !important;
        position: fixed !important;
        bottom: 84px !important; left: 24px !important;
        width: 360px !important; max-height: 520px !important; min-height: 320px !important;
        background: #ffffff !important;
        border-radius: 16px !important;
        box-shadow: 0 8px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08) !important;
        z-index: 2147483641 !important;
        flex-direction: column !important;
        overflow: hidden !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif !important;
        font-size: 13px !important; line-height: 1.5 !important; color: #111827 !important;
        border: 1px solid rgba(79,70,229,0.12) !important;
        box-sizing: border-box !important;
        animation: aa-chat-slide-up 0.2s ease !important;
      }
      @keyframes aa-chat-slide-up {
        from { opacity: 0; transform: translateY(12px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }

      /* ── Header ── */
      #${PANEL_ID} .aa-chat-header {
        all: revert !important;
        display: flex !important; align-items: center !important; gap: 9px !important;
        flex-shrink: 0 !important; flex-grow: 0 !important;
        background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%) !important;
        padding: 12px 14px 11px !important;
        box-sizing: border-box !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
      }
      #${PANEL_ID} .aa-chat-header-dot {
        width: 8px !important; height: 8px !important; border-radius: 50% !important;
        background: #6EE7B7 !important; flex-shrink: 0 !important;
        box-shadow: 0 0 0 2px rgba(110,231,183,0.35) !important;
        display: block !important;
      }
      #${PANEL_ID} .aa-chat-header-title {
        display: block !important; flex: 1 !important;
        font-size: 13px !important; font-weight: 600 !important;
        color: #fff !important; margin: 0 !important; padding: 0 !important;
        line-height: 1.3 !important;
      }
      #${PANEL_ID} .aa-chat-header-sub {
        display: block !important;
        font-size: 10px !important; color: rgba(255,255,255,0.65) !important;
        font-weight: 400 !important; margin: 1px 0 0 !important; padding: 0 !important;
        line-height: 1.2 !important;
      }
      #${PANEL_ID} .aa-chat-header-close {
        all: revert !important;
        background: rgba(255,255,255,0.15) !important; border: none !important;
        border-radius: 6px !important; width: 24px !important; height: 24px !important;
        cursor: pointer !important; display: flex !important;
        align-items: center !important; justify-content: center !important;
        color: #fff !important; font-size: 14px !important; font-weight: 400 !important;
        transition: background 0.15s !important; flex-shrink: 0 !important;
        line-height: 1 !important; padding: 0 !important;
      }
      #${PANEL_ID} .aa-chat-header-close:hover { background: rgba(255,255,255,0.25) !important; }

      /* ── Messages area ── */
      #${PANEL_ID} .aa-messages {
        flex: 1 !important; overflow-y: auto !important;
        padding: 12px 12px 4px !important;
        display: flex !important; flex-direction: column !important;
        gap: 8px !important; scroll-behavior: smooth !important;
        background: #fff !important; box-sizing: border-box !important;
      }
      #${PANEL_ID} .aa-messages::-webkit-scrollbar { width: 4px !important; }
      #${PANEL_ID} .aa-messages::-webkit-scrollbar-track { background: transparent !important; }
      #${PANEL_ID} .aa-messages::-webkit-scrollbar-thumb { background: #E5E7EB !important; border-radius: 2px !important; }

      #${PANEL_ID} .aa-msg {
        max-width: 88% !important; font-size: 13px !important;
        line-height: 1.5 !important; padding: 8px 11px !important;
        border-radius: 12px !important; word-break: break-word !important;
        margin: 0 !important; box-sizing: border-box !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
      }
      #${PANEL_ID} .aa-msg.user {
        align-self: flex-end !important;
        background: #4F46E5 !important; color: #fff !important;
        border-bottom-right-radius: 4px !important;
      }
      #${PANEL_ID} .aa-msg.assistant {
        align-self: flex-start !important;
        background: #F3F4F6 !important; color: #111827 !important;
        border-bottom-left-radius: 4px !important;
      }
      #${PANEL_ID} .aa-msg-time {
        font-size: 10px !important; color: #9CA3AF !important;
        margin: 1px 2px 0 !important; line-height: 1 !important;
        display: block !important;
      }
      #${PANEL_ID} .aa-msg-time.user { align-self: flex-end !important; }

      /* ── Typing indicator ── */
      #${PANEL_ID} .aa-typing {
        align-self: flex-start !important; background: #F3F4F6 !important;
        border-radius: 12px 12px 12px 4px !important;
        padding: 8px 14px !important;
        display: flex !important; gap: 4px !important; align-items: center !important;
      }
      #${PANEL_ID} .aa-typing span {
        width: 6px !important; height: 6px !important;
        background: #9CA3AF !important; border-radius: 50% !important;
        animation: aa-bounce 1.2s ease-in-out infinite !important;
        display: inline-block !important;
      }
      #${PANEL_ID} .aa-typing span:nth-child(2) { animation-delay: 0.2s !important; }
      #${PANEL_ID} .aa-typing span:nth-child(3) { animation-delay: 0.4s !important; }
      @keyframes aa-bounce {
        0%,60%,100% { transform: translateY(0); }
        30% { transform: translateY(-5px); }
      }

      /* ── Empty state ── */
      #${PANEL_ID} .aa-empty-state {
        flex: 1 !important; display: flex !important;
        flex-direction: column !important; align-items: center !important;
        justify-content: center !important; gap: 6px !important;
        padding: 24px 16px !important; text-align: center !important;
        background: #fff !important;
      }
      #${PANEL_ID} .aa-empty-icon { font-size: 32px !important; line-height: 1 !important; display: block !important; }
      #${PANEL_ID} .aa-empty-title {
        font-size: 13px !important; font-weight: 600 !important;
        color: #374151 !important; margin: 0 !important; display: block !important;
      }
      #${PANEL_ID} .aa-empty-sub {
        font-size: 12px !important; color: #9CA3AF !important;
        margin: 0 !important; display: block !important; line-height: 1.5 !important;
      }

      /* ── Suggestion chips ── */
      #${PANEL_ID} .aa-chips {
        padding: 0 10px 8px !important; display: flex !important;
        flex-wrap: wrap !important; gap: 5px !important;
        flex-shrink: 0 !important; background: #fff !important;
      }
      #${PANEL_ID} .aa-chip {
        all: revert !important;
        font-size: 11px !important; color: #4F46E5 !important;
        background: #EEF2FF !important; border: 1px solid #C7D2FE !important;
        border-radius: 20px !important; padding: 3px 10px !important;
        cursor: pointer !important; white-space: nowrap !important;
        font-family: inherit !important; line-height: 1.5 !important;
        transition: background 0.12s !important;
      }
      #${PANEL_ID} .aa-chip:hover { background: #E0E7FF !important; }

      /* ── Context bar ── */
      #${PANEL_ID} .aa-context-bar {
        margin: 0 10px 6px !important; background: #FFF7ED !important;
        border: 1px solid #FED7AA !important; border-radius: 8px !important;
        padding: 6px 10px !important; font-size: 11px !important;
        color: #92400E !important; display: flex !important;
        align-items: center !important; gap: 6px !important; flex-shrink: 0 !important;
      }
      #${PANEL_ID} .aa-context-bar-text { flex: 1 !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
      #${PANEL_ID} .aa-context-bar-clear { cursor: pointer !important; font-size: 13px !important; color: #B45309 !important; flex-shrink: 0 !important; }

      /* ── Toolbar ── */
      #${PANEL_ID} .aa-toolbar {
        padding: 6px 10px !important; display: flex !important;
        align-items: center !important; gap: 5px !important;
        border-top: 1px solid #F3F4F6 !important; flex-shrink: 0 !important;
        background: #fff !important;
      }
      #${PANEL_ID} .aa-toolbar-btn {
        all: revert !important;
        background: none !important; border: 1px solid #E5E7EB !important;
        border-radius: 6px !important; padding: 4px 8px !important;
        font-size: 11px !important; color: #6B7280 !important;
        cursor: pointer !important; font-family: inherit !important;
        display: inline-flex !important; align-items: center !important;
        gap: 4px !important; white-space: nowrap !important;
        transition: all 0.12s !important; line-height: 1.4 !important;
      }
      #${PANEL_ID} .aa-toolbar-btn:hover { background: #F3F4F6 !important; color: #374151 !important; }
      #${PANEL_ID} .aa-toolbar-btn.active { background: #EEF2FF !important; border-color: #C7D2FE !important; color: #4F46E5 !important; }

      /* ── Input row ── */
      #${PANEL_ID} .aa-input-row {
        padding: 8px 10px 10px !important; display: flex !important;
        gap: 6px !important; align-items: flex-end !important;
        flex-shrink: 0 !important; background: #fff !important;
        box-sizing: border-box !important;
      }
      #${PANEL_ID} #aa-chat-input {
        all: revert !important;
        flex: 1 !important; border: 1px solid #E5E7EB !important;
        border-radius: 10px !important; padding: 7px 11px !important;
        font-size: 13px !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        color: #111827 !important; background: #F9FAFB !important;
        outline: none !important; resize: none !important;
        max-height: 80px !important; min-height: 34px !important;
        overflow-y: auto !important; line-height: 1.4 !important;
        box-sizing: border-box !important;
      }
      #${PANEL_ID} #aa-chat-input:focus { border-color: #A5B4FC !important; background: #fff !important; }
      #${PANEL_ID} #aa-chat-input::placeholder { color: #D1D5DB !important; }
      #${PANEL_ID} .aa-send-btn {
        all: revert !important;
        width: 32px !important; height: 32px !important;
        border-radius: 8px !important; background: #4F46E5 !important;
        border: none !important; cursor: pointer !important;
        display: flex !important; align-items: center !important; justify-content: center !important;
        flex-shrink: 0 !important;
      }
      #${PANEL_ID} .aa-send-btn:hover { background: #4338CA !important; }
      #${PANEL_ID} .aa-send-btn:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }
      #${PANEL_ID} .aa-send-btn svg { width: 15px !important; height: 15px !important; fill: #fff !important; }

      /* Inspect mode — highlight hovered page elements */
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
    panel.style.setProperty("display", "none", "important");
    panel.innerHTML = `
      <div class="aa-chat-header">
        <div class="aa-chat-header-dot"></div>
        <div style="flex:1;min-width:0;overflow:hidden;">
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
      panel.style.setProperty("display", "flex", "important");
      panel.style.flexDirection = "column";
      renderMessages();
      setTimeout(() => document.getElementById("aa-chat-input")?.focus(), 80);
    }
  }

  function closePanel() {
    isOpen = false;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.setProperty("display", "none", "important");
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
