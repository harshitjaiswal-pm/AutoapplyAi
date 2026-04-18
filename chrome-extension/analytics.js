/**
 * analytics.js — AutoApply Event Tracking
 *
 * Exposes: AutoApplyAnalytics.trackEvent(type, payload)
 *
 * Architecture:
 *   1. Writes to chrome.storage.local ring buffer (last 500 events)
 *   2. POSTs to /api/events/ingest with retry + offline queue
 *   3. All events carry userId, sessionId, extensionVersion, timestamp
 *
 * Usage in ATS scripts / background.js:
 *   AutoApplyAnalytics.trackEvent("application_submitted", { jobId, ... });
 *
 * Note: This file is loaded by background.js (service worker context) via importScripts
 * or inline, and by content scripts that have access to chrome.storage.
 */

(() => {
  const RING_BUFFER_KEY  = "_aa_events_ring";
  const RING_BUFFER_MAX  = 500;
  const OFFLINE_QUEUE_KEY = "_aa_events_queue";
  const OFFLINE_QUEUE_MAX = 200;
  const EXT_VERSION      = chrome.runtime?.getManifest?.()?.version || "unknown";

  // Session ID persists for the browser session (service worker lifecycle)
  let _sessionId = null;
  function getSessionId() {
    if (!_sessionId) _sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return _sessionId;
  }

  /**
   * Core tracking function. Called from anywhere in the extension.
   * @param {string} type - Event type (e.g. "application_submitted")
   * @param {Object} payload - Event-specific fields
   */
  async function trackEvent(type, payload = {}) {
    try {
      const stored = await chrome.storage.local.get(["autoapplyUrl", "_aa_userId"]);
      const userId = stored._aa_userId || "anonymous";
      const apiUrl = stored.autoapplyUrl || "https://autoapply-ai-delta.vercel.app";

      const event = {
        type,
        userId,
        sessionId:        getSessionId(),
        extensionVersion: EXT_VERSION,
        timestamp:        new Date().toISOString(),
        timestampMs:      Date.now(),
        ...payload,
      };

      // 1. Write to ring buffer (fire-and-forget)
      _writeToRingBuffer(event);

      // 2. POST to server (with offline queue fallback)
      _postEvent(event, apiUrl);
    } catch (err) {
      // Analytics must never break the main flow
      console.warn("AutoApply Analytics: trackEvent error:", err.message);
    }
  }

  /**
   * Write event to local ring buffer. Trims to last RING_BUFFER_MAX entries.
   */
  function _writeToRingBuffer(event) {
    chrome.storage.local.get([RING_BUFFER_KEY], (result) => {
      const ring = Array.isArray(result[RING_BUFFER_KEY]) ? result[RING_BUFFER_KEY] : [];
      ring.push(event);
      const trimmed = ring.slice(-RING_BUFFER_MAX);
      chrome.storage.local.set({ [RING_BUFFER_KEY]: trimmed });
    });
  }

  /**
   * POST event to /api/events/ingest. Queues on failure for retry.
   */
  async function _postEvent(event, apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/api/events/ingest`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(event),
        // No credentials: auth via userId in payload (server verifies session separately)
      });
      if (!res.ok) {
        console.warn(`AutoApply Analytics: ingest HTTP ${res.status} — queuing`);
        _queueEvent(event);
      } else {
        // Success — attempt to drain any queued events
        _drainQueue(apiUrl);
      }
    } catch (_networkErr) {
      // Offline — queue for later
      _queueEvent(event);
    }
  }

  /**
   * Add event to offline queue (capped at OFFLINE_QUEUE_MAX).
   */
  function _queueEvent(event) {
    chrome.storage.local.get([OFFLINE_QUEUE_KEY], (result) => {
      const queue = Array.isArray(result[OFFLINE_QUEUE_KEY]) ? result[OFFLINE_QUEUE_KEY] : [];
      queue.push(event);
      const trimmed = queue.slice(-OFFLINE_QUEUE_MAX);
      chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: trimmed });
    });
  }

  /**
   * Attempt to send queued events. Called after a successful POST.
   * FIX: Atomically remove-then-send to avoid race condition where concurrent
   * contexts add events between the read and the write (events would be lost).
   * Strategy: snapshot the queue, clear it, attempt sends, re-queue failures.
   */
  async function _drainQueue(apiUrl) {
    const result = await chrome.storage.local.get([OFFLINE_QUEUE_KEY]);
    const queue  = Array.isArray(result[OFFLINE_QUEUE_KEY]) ? result[OFFLINE_QUEUE_KEY] : [];
    if (queue.length === 0) return;

    const snapshot = queue.slice(0, 20); // drain up to 20 at a time
    // Atomically remove the snapshot from the queue before attempting sends.
    // This prevents events from being double-sent if another context drains concurrently.
    await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: queue.slice(snapshot.length) });

    const failed = [];
    for (const evt of snapshot) {
      try {
        const res = await fetch(`${apiUrl}/api/events/ingest`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(evt),
        });
        if (!res.ok) {
          failed.push(evt); // re-queue on server error
          break; // stop on first failure
        }
      } catch (_) {
        failed.push(evt); // re-queue on network error
        break;
      }
    }

    // Re-queue any events that failed to send (prepend to preserve ordering)
    if (failed.length > 0) {
      const current = await chrome.storage.local.get([OFFLINE_QUEUE_KEY]);
      const existing = Array.isArray(current[OFFLINE_QUEUE_KEY]) ? current[OFFLINE_QUEUE_KEY] : [];
      await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: [...failed, ...existing].slice(0, OFFLINE_QUEUE_MAX) });
    }
  }

  /**
   * Normalise company + title for dedup key.
   * "Google" == "Google Inc" == "google inc." == "Google, Inc."
   */
  function normalizeDedupKey(company, title) {
    const normalizeStr = (s) =>
      (s || "")
        .toLowerCase()
        .replace(/[,\.]+/g, "")                        // strip punctuation
        .replace(/\b(inc|llc|ltd|corp|co|company|technologies|solutions|group|global)\b/g, "") // strip suffixes
        .replace(/\s+/g, " ")
        .trim();
    return `${normalizeStr(company)}|${normalizeStr(title)}`;
  }

  /**
   * Check if this company|title combo has already been applied to.
   * Returns true if duplicate.
   */
  async function isDuplicateApplication(company, title) {
    const key   = normalizeDedupKey(company, title);
    const result = await chrome.storage.local.get(["_aa_applied_jobs"]);
    const applied = result._aa_applied_jobs || {};
    return !!applied[key];
  }

  /**
   * Mark a company|title as applied. Call after confirmed submission.
   */
  async function markApplied(company, title, jobUrl) {
    const key    = normalizeDedupKey(company, title);
    const result = await chrome.storage.local.get(["_aa_applied_jobs"]);
    const applied = result._aa_applied_jobs || {};
    applied[key]  = { appliedAt: new Date().toISOString(), jobUrl };
    await chrome.storage.local.set({ _aa_applied_jobs: applied });
  }

  /**
   * Get all events from the ring buffer for debugging.
   */
  async function getRecentEvents(limit = 50) {
    const result = await chrome.storage.local.get([RING_BUFFER_KEY]);
    const ring   = Array.isArray(result[RING_BUFFER_KEY]) ? result[RING_BUFFER_KEY] : [];
    return ring.slice(-limit);
  }

  // Expose globally
  self.AutoApplyAnalytics = {
    trackEvent,
    isDuplicateApplication,
    markApplied,
    normalizeDedupKey,
    getRecentEvents,
  };

  console.log("AutoApply Analytics: v" + EXT_VERSION + " loaded");
})();
