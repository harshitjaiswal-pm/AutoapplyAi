/**
 * AutoApply logger — unified JSON logger for debugging end-to-end flows.
 *
 * Works in:
 *   • content scripts (linkedin, ATS pages)
 *   • background service worker
 *   • popup
 *
 * API (global `AALog`):
 *   AALog.event(stage, category, data)   → log any structured event
 *   AALog.scrape(stage, data)            → shorthand for SCRAPE category
 *   AALog.form(stage, data)              → FORM category
 *   AALog.api(stage, data)               → API category
 *   AALog.nav(stage, data)               → NAV category
 *   AALog.state(stage, data)             → STATE category
 *   AALog.error(stage, data)             → ERROR category (also logs stack if given Error)
 *   AALog.getAll(cb)                     → returns all buffered entries
 *   AALog.clear()                        → wipes the buffer
 *   AALog.export(format)                 → returns a JSON string / markdown report
 *
 * Storage model: ring buffer of the most recent N entries under
 * `chrome.storage.local._aa_logs`. Default N = 2000.
 */
(function () {
  if (typeof self !== "undefined" && self.AALog) return; // already loaded
  if (typeof window !== "undefined" && window.AALog) return;

  const MAX_ENTRIES = 2000;
  const STORAGE_KEY = "_aa_logs";
  const SESSION_KEY = "_aa_log_session";

  // One session id per service-worker boot / page load — lets you group a run.
  const sessionId =
    (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "s-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));

  // Detect context so entries are traceable back to their origin.
  function detectContext() {
    try {
      if (typeof window === "undefined") return "background";
      const href = (window.location && window.location.href) || "";
      if (href.includes("linkedin.com")) return "linkedin";
      if (href.includes("greenhouse.io")) return "ats:greenhouse";
      if (href.includes("lever.co")) return "ats:lever";
      if (href.includes("myworkdayjobs.com")) return "ats:workday";
      if (href.includes("ashbyhq.com")) return "ats:ashby";
      if (href.includes("icims.com")) return "ats:icims";
      if (href.includes("popup.html")) return "popup";
      return "ats:other";
    } catch (e) {
      return "unknown";
    }
  }
  const ctx = detectContext();

  // In-memory queue so rapid-fire logs don't thrash storage.
  let pending = [];
  let flushTimer = null;
  const FLUSH_INTERVAL_MS = 400;

  // Are we running inside the background service worker? If yes, we write
  // directly to storage (and serialize writes ourselves). If no, we forward
  // our batches to background via runtime.sendMessage, which serializes all
  // writes across the entire extension in a single place. This is the fix
  // for the lost-logs race condition where background + content scripts
  // both did read-modify-write on the same key and clobbered each other.
  const isBackground = (typeof window === "undefined");

  // Background-only: a single in-worker write queue shared by both the
  // logger's own flushes and foreign batches forwarded from content scripts.
  // Exposed as self.__aa_enqueueLogWrite so background.js can reuse it.
  function bgEnqueueWrite(toWrite) {
    if (typeof self !== "undefined") {
      self.__aa_logWriteChain = (self.__aa_logWriteChain || Promise.resolve())
        .then(() => new Promise((resolve) => {
          try {
            chrome.storage.local.get([STORAGE_KEY], (result) => {
              const existing = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
              const next = existing.concat(toWrite);
              const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
              chrome.storage.local.set({ [STORAGE_KEY]: trimmed }, resolve);
            });
          } catch (e) { resolve(); }
        }));
      return self.__aa_logWriteChain;
    }
    return Promise.resolve();
  }
  if (typeof self !== "undefined") {
    self.__aa_enqueueLogWrite = bgEnqueueWrite;
  }

  // Fallback: write directly to chrome.storage when background SW is unreachable.
  // Uses a simple in-content-script lock via promise chain to prevent concurrent writes.
  let _directWriteChain = Promise.resolve();
  function directStorageWrite(toWrite) {
    _directWriteChain = _directWriteChain.then(() => new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          const existing = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
          const next = existing.concat(toWrite).slice(-MAX_ENTRIES);
          chrome.storage.local.set({ [STORAGE_KEY]: next }, resolve);
        });
      } catch (_) { resolve(); }
    }));
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  function flush() {
    flushTimer = null;
    if (!pending.length) return;
    const toWrite = pending;
    pending = [];
    try {
      if (isBackground) {
        bgEnqueueWrite(toWrite);
      } else {
        // Content-script / popup → try background first (serialized writes).
        // If SW is idle (MV3 common case), fall back to direct chrome.storage write.
        try {
          chrome.runtime.sendMessage({ __aa_log_batch: true, entries: toWrite }, () => {
            if (chrome.runtime.lastError) {
              // SW unreachable — write directly to storage as fallback
              directStorageWrite(toWrite);
            }
          });
        } catch (e) {
          directStorageWrite(toWrite);
        }
      }
    } catch (e) {
      // chrome.storage not available (unlikely) — drop silently.
    }
  }

  // Safely deep-clone a value for storage. Strips functions, DOM nodes, and
  // circular refs. Keeps the overall shape for JSON serialisation.
  function safeClone(value, depth = 0) {
    if (depth > 5) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value;
    if (t === "function") return "[function]";
    if (value instanceof Error) {
      return { __error: true, name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof Node !== "undefined" && value instanceof Node) {
      return "[DOMNode:" + (value.nodeName || "?") + "]";
    }
    if (Array.isArray(value)) {
      return value.slice(0, 200).map((v) => safeClone(v, depth + 1));
    }
    if (t === "object") {
      const out = {};
      let count = 0;
      for (const k of Object.keys(value)) {
        if (count++ > 100) { out.__truncated = true; break; }
        try { out[k] = safeClone(value[k], depth + 1); }
        catch (e) { out[k] = "[unserialisable]"; }
      }
      return out;
    }
    return String(value);
  }

  const CATEGORY_STYLES = {
    SCRAPE: "background:#2563EB;color:white;padding:2px 6px;border-radius:3px;",
    FORM:   "background:#059669;color:white;padding:2px 6px;border-radius:3px;",
    API:    "background:#7C3AED;color:white;padding:2px 6px;border-radius:3px;",
    NAV:    "background:#0891B2;color:white;padding:2px 6px;border-radius:3px;",
    STATE:  "background:#6B7280;color:white;padding:2px 6px;border-radius:3px;",
    ERROR:  "background:#DC2626;color:white;padding:2px 6px;border-radius:3px;",
    INFO:   "background:#111;color:white;padding:2px 6px;border-radius:3px;",
  };

  function log(stage, category, data) {
    const entry = {
      ts: new Date().toISOString(),
      t: Date.now(),
      session: sessionId,
      ctx,
      url: (typeof window !== "undefined" && window.location) ? window.location.href : "",
      stage: String(stage || ""),
      category: String(category || "INFO").toUpperCase(),
      data: safeClone(data),
    };

    // Console output — styled and grouped by category.
    try {
      const style = CATEGORY_STYLES[entry.category] || CATEGORY_STYLES.INFO;
      const method = entry.category === "ERROR" ? "error" : "log";
      // eslint-disable-next-line no-console
      console[method](
        `%c${entry.category}%c ${entry.ctx} · ${entry.stage}`,
        style,
        "color:#555;",
        entry.data
      );
    } catch (_) {}

    pending.push(entry);
    scheduleFlush();
    return entry;
  }

  const AALog = {
    sessionId,
    event: log,
    scrape: (stage, data) => log(stage, "SCRAPE", data),
    form:   (stage, data) => log(stage, "FORM", data),
    api:    (stage, data) => log(stage, "API", data),
    nav:    (stage, data) => log(stage, "NAV", data),
    state:  (stage, data) => log(stage, "STATE", data),
    info:   (stage, data) => log(stage, "INFO", data),
    error:  (stage, data) => log(stage, "ERROR", data instanceof Error
      ? { message: data.message, stack: data.stack, name: data.name }
      : data),

    getAll(cb) {
      flush();
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          cb(Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []);
        });
      } catch (e) { cb([]); }
    },

    clear() {
      pending = [];
      try { chrome.storage.local.set({ [STORAGE_KEY]: [] }); } catch (_) {}
    },

    // Return a JSON string of the current buffer (async via callback).
    export(cb, format = "json") {
      this.getAll((entries) => {
        if (format === "markdown") {
          const lines = ["# AutoApply debug log", `Session: ${sessionId}`, `Exported: ${new Date().toISOString()}`, `Entries: ${entries.length}`, ""];
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
          cb(lines.join("\n"));
          return;
        }
        try { cb(JSON.stringify(entries, null, 2)); }
        catch (_) { cb("[]"); }
      });
    },
  };

  // Catch uncaught errors + promise rejections automatically (content contexts only).
  try {
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("error", (ev) => {
        AALog.error("window.error", {
          message: ev.message,
          filename: ev.filename,
          line: ev.lineno,
          col: ev.colno,
          stack: ev.error && ev.error.stack,
        });
      });
      window.addEventListener("unhandledrejection", (ev) => {
        AALog.error("window.unhandledrejection", {
          reason: ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason),
          stack: ev.reason && ev.reason.stack,
        });
      });
    } else if (typeof self !== "undefined" && self.addEventListener) {
      // service worker context
      self.addEventListener("error", (ev) => {
        AALog.error("sw.error", { message: ev.message, filename: ev.filename });
      });
      self.addEventListener("unhandledrejection", (ev) => {
        AALog.error("sw.unhandledrejection", {
          reason: ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason),
        });
      });
    }
  } catch (_) {}

  // Expose globally for both window and service-worker contexts.
  if (typeof window !== "undefined") window.AALog = AALog;
  if (typeof self !== "undefined") self.AALog = AALog;

  // Mark session start so exports always have a clear boundary.
  log("logger.init", "STATE", { session: sessionId, context: ctx });
})();
