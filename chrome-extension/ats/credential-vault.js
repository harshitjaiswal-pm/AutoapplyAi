/**
 * AutoApply — Credential Vault
 *
 * Encrypted credential storage for password-gated ATS sites (BrainHunter,
 * Workday, Taleo, iCIMS, SuccessFactors, etc.). Unblocks auto-login flows
 * so Claude / the extension never has to type plaintext passwords itself.
 *
 * Design goals:
 *   1. Plaintext passwords NEVER touch disk. Only AES-GCM ciphertext does.
 *   2. Encryption key lives in the background service worker's in-memory
 *      state only. When the worker dies (MV3 ~30s idle) or the user locks
 *      the vault, the key reference is dropped. No long-term secret on disk.
 *   3. Key is derived from a user-supplied master passphrase via PBKDF2
 *      (SHA-256, 310k iterations). A fixed-string "probe" ciphertext lets
 *      us verify the passphrase on unlock without trial-decrypting real
 *      entries.
 *   4. Auto-lock: after 15 minutes of inactivity the key is dropped.
 *   5. This module is loaded by the background service worker via
 *      importScripts. It exposes its API on the global `self` object as
 *      `self.AAVault`. It does NOT run in content-script context.
 *
 * Storage shape (chrome.storage.local):
 *   _vault_meta: {
 *     version: 1,
 *     kdfSalt: base64(16 bytes),
 *     kdfIterations: 310000,
 *     createdAt: ISO,
 *   }
 *   _vault_probe: {
 *     iv: base64(12 bytes),
 *     ciphertext: base64,          // AES-GCM("AA_VAULT_OK_v1")
 *   }
 *   _vault_entries: {
 *     "brainhunter.com": {
 *       username: "kiran...@gmail.com",
 *       iv: base64(12 bytes),
 *       ciphertext: base64,        // AES-GCM(password utf8)
 *       autoSubmit: false,
 *       notes: "",
 *       updatedAt: ISO,
 *     },
 *     ...
 *   }
 */

(() => {
  "use strict";

  const VAULT_VERSION = 1;
  const KDF_ITERATIONS = 310000;
  const KDF_SALT_BYTES = 16;
  const IV_BYTES = 12;
  const PROBE_PLAINTEXT = "AA_VAULT_OK_v1";
  const AUTO_LOCK_MS = 15 * 60 * 1000; // 15 minutes

  // In-memory state. Dropped when service worker dies or on lock().
  /** @type {CryptoKey | null} */
  let vaultKey = null;
  let autoLockTimer = null;

  /* ── Base64 helpers ─────────────────────────────────────────────────── */

  function b64encode(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }

  function b64decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ── Storage helpers ────────────────────────────────────────────────── */

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }
  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  /* ── Crypto primitives ──────────────────────────────────────────────── */

  async function deriveKey(passphrase, saltBytes) {
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: KDF_ITERATIONS,
        hash: "SHA-256",
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptString(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const enc = new TextEncoder();
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(plaintext)
    );
    return { iv: b64encode(iv), ciphertext: b64encode(new Uint8Array(ct)) };
  }

  async function decryptString(key, ivB64, ctB64) {
    const iv = b64decode(ivB64);
    const ct = b64decode(ctB64);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  /* ── Auto-lock timer ────────────────────────────────────────────────── */

  function scheduleAutoLock() {
    if (autoLockTimer) clearTimeout(autoLockTimer);
    autoLockTimer = setTimeout(() => {
      console.log("AutoApply Vault: auto-lock fired");
      vaultKey = null;
      autoLockTimer = null;
    }, AUTO_LOCK_MS);
  }

  function cancelAutoLock() {
    if (autoLockTimer) clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }

  /* ── Public API ─────────────────────────────────────────────────────── */

  /**
   * Returns { exists: boolean, unlocked: boolean, autoLockMs }
   */
  async function status() {
    const { _vault_meta } = await storageGet(["_vault_meta"]);
    return {
      exists: !!_vault_meta,
      unlocked: !!vaultKey,
      version: _vault_meta?.version || null,
      autoLockMs: AUTO_LOCK_MS,
    };
  }

  /**
   * First-time setup. Creates meta, salt, probe ciphertext. If a vault
   * already exists this is a no-op and returns { created: false }.
   * NOTE: you still need to call unlock() afterwards.
   */
  async function init(passphrase) {
    if (!passphrase || typeof passphrase !== "string" || passphrase.length < 8) {
      return { ok: false, error: "passphrase must be at least 8 characters" };
    }
    const existing = await storageGet(["_vault_meta"]);
    if (existing._vault_meta) {
      return { ok: false, error: "vault already exists — use unlock" };
    }
    const salt = crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
    const key = await deriveKey(passphrase, salt);
    const probe = await encryptString(key, PROBE_PLAINTEXT);

    await storageSet({
      _vault_meta: {
        version: VAULT_VERSION,
        kdfSalt: b64encode(salt),
        kdfIterations: KDF_ITERATIONS,
        createdAt: new Date().toISOString(),
      },
      _vault_probe: probe,
      _vault_entries: {},
    });

    vaultKey = key;
    scheduleAutoLock();
    console.log("AutoApply Vault: initialized and unlocked");
    return { ok: true, created: true };
  }

  /**
   * Derive key from passphrase and verify against the probe ciphertext.
   * On success the key is cached in-memory for up to AUTO_LOCK_MS.
   */
  async function unlock(passphrase) {
    if (!passphrase) return { ok: false, error: "no passphrase" };
    const { _vault_meta, _vault_probe } = await storageGet([
      "_vault_meta",
      "_vault_probe",
    ]);
    if (!_vault_meta || !_vault_probe) {
      return { ok: false, error: "no vault — call init first" };
    }
    const salt = b64decode(_vault_meta.kdfSalt);
    let key;
    try {
      key = await deriveKey(passphrase, salt);
    } catch (e) {
      return { ok: false, error: "key derivation failed" };
    }
    try {
      const decoded = await decryptString(
        key,
        _vault_probe.iv,
        _vault_probe.ciphertext
      );
      if (decoded !== PROBE_PLAINTEXT) {
        return { ok: false, error: "wrong passphrase" };
      }
    } catch (e) {
      return { ok: false, error: "wrong passphrase" };
    }
    vaultKey = key;
    scheduleAutoLock();
    console.log("AutoApply Vault: unlocked");
    return { ok: true };
  }

  /**
   * Drop the in-memory key. The caller's key material is not recoverable
   * from storage without the passphrase.
   */
  function lock() {
    vaultKey = null;
    cancelAutoLock();
    console.log("AutoApply Vault: locked");
    return { ok: true };
  }

  /**
   * Store or update a credential entry for a host.
   * host is the site hostname, e.g. "brainhunter.com".
   */
  async function setEntry({ host, username, password, autoSubmit, notes }) {
    if (!vaultKey) return { ok: false, locked: true };
    if (!host || !username || !password) {
      return { ok: false, error: "host, username, password required" };
    }
    const normalized = host.toLowerCase().trim();
    const { iv, ciphertext } = await encryptString(vaultKey, password);
    const { _vault_entries = {} } = await storageGet(["_vault_entries"]);
    _vault_entries[normalized] = {
      username,
      iv,
      ciphertext,
      autoSubmit: !!autoSubmit,
      notes: notes || "",
      updatedAt: new Date().toISOString(),
    };
    await storageSet({ _vault_entries });
    scheduleAutoLock();
    console.log("AutoApply Vault: set entry for", normalized);
    return { ok: true };
  }

  /**
   * Fetch a decrypted credential pair for a host.
   * Matches exact hostname first, then falls back to a suffix match
   * (e.g. "jobs.phsa.ca" matches a stored "phsa.ca" entry — useful for
   * portal subdomains that share a login with the parent).
   */
  async function getEntry(host) {
    if (!vaultKey) return { ok: false, locked: true };
    const normalized = (host || "").toLowerCase().trim();
    const { _vault_entries = {} } = await storageGet(["_vault_entries"]);

    let key = normalized;
    let entry = _vault_entries[key];

    if (!entry) {
      // Suffix / parent-domain fallback
      const parts = normalized.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join(".");
        if (_vault_entries[parent]) {
          key = parent;
          entry = _vault_entries[parent];
          break;
        }
      }
    }

    if (!entry) return { ok: false, notFound: true };

    try {
      const password = await decryptString(vaultKey, entry.iv, entry.ciphertext);
      scheduleAutoLock();
      return {
        ok: true,
        host: key,
        username: entry.username,
        password,
        autoSubmit: !!entry.autoSubmit,
        notes: entry.notes || "",
      };
    } catch (e) {
      return { ok: false, error: "decrypt failed — wrong key?" };
    }
  }

  /**
   * Return metadata for all stored entries. NEVER includes decrypted
   * passwords. Safe to send to popup UI.
   */
  async function listEntries() {
    const { _vault_entries = {} } = await storageGet(["_vault_entries"]);
    const entries = Object.entries(_vault_entries).map(([host, e]) => ({
      host,
      username: e.username,
      autoSubmit: !!e.autoSubmit,
      notes: e.notes || "",
      updatedAt: e.updatedAt || null,
    }));
    entries.sort((a, b) => a.host.localeCompare(b.host));
    return { ok: true, entries, unlocked: !!vaultKey };
  }

  async function deleteEntry(host) {
    const normalized = (host || "").toLowerCase().trim();
    const { _vault_entries = {} } = await storageGet(["_vault_entries"]);
    if (!_vault_entries[normalized]) return { ok: false, notFound: true };
    delete _vault_entries[normalized];
    await storageSet({ _vault_entries });
    console.log("AutoApply Vault: deleted entry for", normalized);
    return { ok: true };
  }

  /**
   * Nuclear option — wipe the entire vault including meta, probe, entries.
   * Used when the user forgets their passphrase.
   */
  async function destroy() {
    vaultKey = null;
    cancelAutoLock();
    await storageRemove(["_vault_meta", "_vault_probe", "_vault_entries"]);
    console.log("AutoApply Vault: destroyed");
    return { ok: true };
  }

  /* ── Expose API on self for background.js ──────────────────────────── */

  self.AAVault = {
    status,
    init,
    unlock,
    lock,
    setEntry,
    getEntry,
    listEntries,
    deleteEntry,
    destroy,
  };

  console.log("AutoApply Vault: module loaded");
})();
