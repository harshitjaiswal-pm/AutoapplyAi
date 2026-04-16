/**
 * AutoApply — BrainHunter ATS Handler
 *
 * Runs on brainhunter.com (used by PHSA, other BC health-sector employers,
 * and some Canadian public-sector sites).
 *
 * BrainHunter is a traditional server-rendered Java ATS — standard HTML forms,
 * standard <input type="file">, classic POST submit. Much simpler than the
 * React/SuccessFactors cases. No SFFileUpload equivalent needed.
 *
 * What this handler does:
 *   1. Detects the current page type (login gate, registration, profile form,
 *      job application form, confirmation).
 *   2. On login gate: surfaces an AA_LOGIN_REQUIRED postMessage so the panel
 *      can tell the user "log in, then I'll take over".
 *   3. On profile form: auto-fills name, email, phone, address, etc. from
 *      the extension's saved profile. Never touches password fields.
 *   4. On application form: auto-fills standard fields and uses the native
 *      <input type="file"> for resume upload by fetching the tailored PDF
 *      from chrome.storage.local and dispatching it via DataTransfer.
 *   5. Handles "Apply Online Now" navigation flow and pre-screening questions
 *      where safe to do so (Yes/No, dropdowns — never EEOC).
 */

(() => {
  if (window.__autoapply_brainhunter_injected) return;
  window.__autoapply_brainhunter_injected = true;

  const LOG = (...a) => console.log("AutoApply BrainHunter:", ...a);
  LOG("BrainHunter ATS script loaded on", window.location.href);

  /* ══════════════════════════════════════════════════════════════════════
   * PROFILE DEFAULTS — overridden by extension storage when available
   * ══════════════════════════════════════════════════════════════════════ */

  const PROFILE_DEFAULTS = {
    firstName: "KIRAN",
    lastName:  "SHAHI",
    email:     "kiranshahi.can@gmail.com",
    phone:     "2369796746",
    country:   "Canada",
    state:     "British Columbia",
    city:      "Vancouver",
    street:    "1600M Beach Ave",
    postal:    "V6G 1Y7",
  };

  /* ══════════════════════════════════════════════════════════════════════
   * UTILITIES
   * ══════════════════════════════════════════════════════════════════════ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function triggerInputChange(el, value) {
    if (!el) return;
    const proto =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
    if (proto && proto.set) proto.set.call(el, value);
    else el.value = value;
    ["input", "change", "blur"].forEach((t) =>
      el.dispatchEvent(new Event(t, { bubbles: true }))
    );
  }

  function triggerSelectChange(el, value) {
    if (!el) return false;
    const v = String(value).toLowerCase();
    const opt = Array.from(el.options).find(
      (o) =>
        o.value.toLowerCase() === v ||
        o.text.toLowerCase() === v ||
        o.text.toLowerCase().includes(v)
    );
    if (opt) {
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }

  async function waitForEl(selector, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * PAGE TYPE DETECTION
   * ══════════════════════════════════════════════════════════════════════ */

  function detectPageType() {
    const url = window.location.href.toLowerCase();
    const body = (document.body?.innerText || "").toLowerCase();

    // Login / register gate — MUST have an actual password field on the page.
    // Without this extra check we false-positive on post-login pages that
    // happen to use the same jobdetaildispatch URL (e.g. the PHSA Apply flow
    // after the user has already signed in), and we'd wastefully call the
    // vault on every such page.
    const hasPasswordField = !!document.querySelector('input[type="password"]');
    if (
      hasPasswordField &&
      (
        url.includes("jobdetaildispatch") ||
        /please enter your password/.test(body) ||
        /\blogin below if you have already created a profile\b/.test(body)
      )
    ) {
      return "login-gate";
    }
    if (url.includes("seekercreateaccount") || /^register/.test(document.title || "")) {
      return "register";
    }
    // Profile / resume form
    if (url.includes("seekerprofile") || url.includes("editprofile")) {
      return "profile";
    }
    // Application form
    if (url.includes("applyforjob") || url.includes("applyjob")) {
      return "apply";
    }
    if (url.includes("confirmation") || url.includes("thankyou")) {
      return "confirmation";
    }
    return "unknown";
  }

  /* ══════════════════════════════════════════════════════════════════════
   * LOGIN GATE — pull stored credentials from the encrypted vault and
   * auto-fill the username/password fields. The extension owns the
   * secret (user stored it explicitly, key is derived from their master
   * passphrase), so this is safe and stays within the AutoApply trust
   * boundary — no external actor types a password.
   *
   * Fallback path: if the vault is locked or there's no entry for this
   * host, we surface AA_LOGIN_REQUIRED so the panel prompts the user.
   * ══════════════════════════════════════════════════════════════════════ */

  function vaultMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: "no response" });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function findUsernameField() {
    const sels = [
      'input[type="email"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.type !== "password") return el;
    }
    // Last resort: first visible text input that isn't a password
    return document.querySelector('input[type="text"]:not([disabled])');
  }

  async function handleLoginGate() {
    LOG("Login gate detected — querying credential vault");
    const host = window.location.hostname;

    const status = await vaultMessage({ type: "VAULT_STATUS" });
    if (!status || !status.exists) {
      LOG("No vault configured — surfacing AA_LOGIN_REQUIRED");
      window.postMessage(
        {
          type: "AA_LOGIN_REQUIRED",
          ats: "brainhunter",
          reason: "no-vault",
          hint:
            "Open the AutoApply popup → Vault tab to create a credential " +
            "vault, then add your login for " + host + ".",
        },
        "*"
      );
      return;
    }
    if (!status.unlocked) {
      LOG("Vault locked — surfacing AA_LOGIN_REQUIRED");
      window.postMessage(
        {
          type: "AA_LOGIN_REQUIRED",
          ats: "brainhunter",
          reason: "vault-locked",
          hint: "Vault is locked. Click the AutoApply icon → Vault → unlock.",
        },
        "*"
      );
      return;
    }

    const entry = await vaultMessage({ type: "VAULT_GET", host });
    if (!entry?.ok) {
      if (entry?.notFound) {
        LOG("Vault has no entry for " + host);
        window.postMessage(
          {
            type: "AA_LOGIN_REQUIRED",
            ats: "brainhunter",
            reason: "entry-missing",
            host,
            hint:
              "No credentials for " + host + " in your vault. Open the " +
              "AutoApply popup → Vault → add an entry.",
          },
          "*"
        );
      } else {
        LOG("Vault lookup failed:", entry?.error);
      }
      return;
    }

    const usernameEl = findUsernameField();
    const passwordEl = document.querySelector('input[type="password"]');

    if (!passwordEl) {
      LOG("No password field found on page — nothing to fill");
      return;
    }

    if (usernameEl && entry.username) {
      triggerInputChange(usernameEl, entry.username);
      LOG("✓ Username filled from vault");
    }
    triggerInputChange(passwordEl, entry.password);
    LOG("✓ Password filled from vault");

    // Zero out the local reference immediately
    entry.password = null;

    // Optional auto-submit — only when user explicitly opted in per-entry
    if (entry.autoSubmit) {
      await sleep(300);
      const submitBtn =
        document.querySelector(
          'button[type="submit"], input[type="submit"], button[id*="login" i], button[name*="login" i]'
        ) || Array.from(document.querySelectorAll("button, input")).find((el) =>
          /log\s*in|sign\s*in|continue/i.test(el.textContent || el.value || "")
        );
      if (submitBtn) {
        LOG("Auto-clicking submit");
        submitBtn.click();
      } else {
        LOG("Auto-submit enabled but no submit button found");
      }
    } else {
      LOG("Auto-submit disabled — waiting for user to press Enter");
    }

    window.postMessage(
      { type: "AA_LOGIN_FILLED", ats: "brainhunter", host },
      "*"
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
   * REGISTRATION — fills the email-entry page, stops before password
   * ══════════════════════════════════════════════════════════════════════ */

  async function handleRegistration(profile) {
    const p = { ...PROFILE_DEFAULTS, ...profile };
    LOG("Handling registration page");

    const emailEls = document.querySelectorAll(
      'input[type="email"], input[name*="email" i], input[id*="email" i]'
    );
    emailEls.forEach((el) => triggerInputChange(el, p.email));
    LOG(`✓ Filled ${emailEls.length} email field(s)`);

    // Never touch password fields — surface the stop point to the panel
    if (document.querySelector('input[type="password"]')) {
      window.postMessage(
        {
          type: "AA_PASSWORD_NEEDED",
          ats: "brainhunter",
          hint: "Please enter a password to finish creating your BrainHunter account.",
        },
        "*"
      );
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * PROFILE FORM — fills standard profile fields
   * ══════════════════════════════════════════════════════════════════════ */

  async function fillProfileForm(profile) {
    const p = { ...PROFILE_DEFAULTS, ...profile };
    LOG("Filling profile form:", p.firstName, p.lastName);
    await sleep(400);

    // Common BrainHunter field name patterns: camelCase IDs, lower-dash names
    const selectors = [
      ["firstName", p.firstName, ['input[name*="firstName" i]', 'input[id*="firstName" i]', 'input[id*="fname" i]']],
      ["lastName",  p.lastName,  ['input[name*="lastName" i]',  'input[id*="lastName" i]',  'input[id*="lname" i]']],
      ["email",     p.email,     ['input[type="email"]',        'input[name*="email" i]',   'input[id*="email" i]']],
      ["phone",     p.phone,     ['input[name*="phone" i]',     'input[id*="phone" i]',     'input[type="tel"]']],
      ["street",    p.street,    ['input[name*="address" i]',   'input[id*="address" i]',   'input[name*="street" i]']],
      ["city",      p.city,      ['input[name*="city" i]',      'input[id*="city" i]']],
      ["postal",    p.postal,    ['input[name*="postal" i]',    'input[id*="postal" i]',    'input[name*="zip" i]']],
    ];

    for (const [label, value, sels] of selectors) {
      const el = sels.map((s) => document.querySelector(s)).find(Boolean);
      if (el) {
        triggerInputChange(el, value);
        LOG(`✓ ${label}`);
      } else {
        LOG(`· no match for ${label}`);
      }
    }

    // Country / Province selects
    const countrySelect = document.querySelector(
      'select[name*="country" i], select[id*="country" i]'
    );
    if (countrySelect) {
      triggerSelectChange(countrySelect, p.country) && LOG("✓ country");
    }
    const provinceSelect = document.querySelector(
      'select[name*="province" i], select[id*="province" i], select[name*="state" i]'
    );
    if (provinceSelect) {
      triggerSelectChange(provinceSelect, p.state) && LOG("✓ province");
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * RESUME UPLOAD — standard <input type="file">
   * BrainHunter uses a classic file input. DataTransfer is enough.
   * ══════════════════════════════════════════════════════════════════════ */

  async function uploadResume() {
    LOG("Upload: requesting PDF from extension storage");

    const result = await new Promise((resolve) => {
      const listener = (e) => {
        if (e.data?.type === "AA_RESUME_PDF_RESULT") {
          window.removeEventListener("message", listener);
          resolve(e.data);
        }
      };
      window.addEventListener("message", listener);
      window.postMessage({ type: "AA_GET_RESUME_PDF" }, "*");
      setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(null);
      }, 4000);
    });

    if (!result?.base64) {
      LOG("Upload: no tailored PDF available — skipping");
      window.postMessage(
        { type: "AA_RESUME_UPLOAD_NEEDED", ats: "brainhunter" },
        "*"
      );
      return false;
    }

    const fileInput = await waitForEl('input[type="file"]');
    if (!fileInput) {
      LOG("Upload: no file input found");
      return false;
    }

    // Decode base64 → File
    const bytes = atob(result.base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const file = new File([arr], result.filename || "Resume.pdf", {
      type: "application/pdf",
    });

    // DataTransfer approach — override .files to bypass isTrusted
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      LOG("✓ Resume uploaded via DataTransfer");
      return true;
    } catch (err) {
      LOG("DataTransfer failed:", err);
      // Fallback: define the files property manually
      try {
        Object.defineProperty(fileInput, "files", {
          value: [file],
          writable: false,
        });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        LOG("✓ Resume uploaded via defineProperty fallback");
        return true;
      } catch (err2) {
        LOG("defineProperty fallback failed:", err2);
        window.postMessage(
          { type: "AA_RESUME_UPLOAD_NEEDED", ats: "brainhunter" },
          "*"
        );
        return false;
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * COVER LETTER — BrainHunter renders a TinyMCE rich-text editor for the
   * cover letter body. The gotcha: that TinyMCE instance is configured in
   * full-page mode, so whatever you set via setContent() gets wrapped in
   *     <!DOCTYPE html><html><head></head><body>…</body></html>
   * and that full document is what gets POSTed in textarea[name="content"].
   * PHSA's BrainHunter Java backend rejects that with an opaque
   *     "Sorry, there are some problems. Error tracking code XXXXX:…"
   * page — submit silently fails.
   *
   * Fix: destroy the TinyMCE instance entirely, write plain text directly
   * into textarea[name="content"], and let the form submit the raw value.
   * Observed working on PHSA BrainHunter 2026-04-14 (Req 197427E-2447661).
   * Also keep the title short and slash-free.
   * ══════════════════════════════════════════════════════════════════════ */

  function sanitizeCoverLetterTitle(raw) {
    const t = String(raw || "Cover Letter")
      .replace(/[\/\\]/g, " ")     // slashes trip BrainHunter validation
      .replace(/\s+/g, " ")
      .trim();
    // BrainHunter cover-letter titles have historically choked above ~60 chars
    return t.length > 60 ? t.slice(0, 57) + "..." : t;
  }

  async function fillCoverLetter({ title, body } = {}) {
    const textarea = document.querySelector('textarea[name="content"]');
    if (!textarea) {
      LOG("Cover letter: no textarea[name=content] on page — nothing to fill");
      return false;
    }

    // 1. Nuke the TinyMCE instance if present — it'd otherwise re-serialize
    //    the textarea as a full HTML document on submit and break things.
    try {
      if (typeof window.tinymce !== "undefined") {
        const ed =
          window.tinymce.get("mce_editor_0") ||
          (window.tinymce.editors && window.tinymce.editors[0]);
        if (ed && typeof ed.remove === "function") {
          ed.remove();
          LOG("Cover letter: removed TinyMCE instance (was fullpage mode)");
        }
      }
    } catch (err) {
      LOG("Cover letter: failed to remove TinyMCE, continuing:", err);
    }

    // 2. Plain text straight into the underlying textarea.
    const plain = String(body || "").replace(/\r\n/g, "\n").trim();
    textarea.value = plain;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    LOG(`✓ Cover letter body (${plain.length} chars) written to textarea[name=content]`);

    // 3. Title — shortened and sanitized.
    const titleEl = document.querySelector(
      'input[name="coverLetterTitle"], input[id*="coverLetterTitle" i]'
    );
    if (titleEl) {
      const safeTitle = sanitizeCoverLetterTitle(title);
      triggerInputChange(titleEl, safeTitle);
      LOG(`✓ Cover letter title: "${safeTitle}"`);
    }

    return true;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * MAIN ROUTER
   * ══════════════════════════════════════════════════════════════════════ */

  async function main() {
    const pageType = detectPageType();
    LOG("Page type:", pageType);

    if (pageType === "login-gate") {
      await handleLoginGate();
      return;
    }
    if (pageType === "register") {
      await handleRegistration({});
      return;
    }
    if (pageType === "profile") {
      await fillProfileForm({});
      await uploadResume();
      return;
    }
    if (pageType === "apply") {
      await fillProfileForm({});
      await uploadResume();
      return;
    }
    if (pageType === "confirmation") {
      LOG("Confirmation page reached");
      window.postMessage(
        { type: "AA_APPLICATION_SUBMITTED", ats: "brainhunter" },
        "*"
      );
      return;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * MESSAGE BRIDGE — lets the panel / background tell us to fill/upload
   * ══════════════════════════════════════════════════════════════════════ */

  window.addEventListener("message", (e) => {
    if (!e.data || typeof e.data !== "object") return;
    if (e.data.type === "AA_BRAINHUNTER_FILL") {
      fillProfileForm(e.data.profile || {}).then(() => uploadResume());
    }
    if (e.data.type === "AA_BRAINHUNTER_UPLOAD") {
      uploadResume();
    }
    if (e.data.type === "AA_BRAINHUNTER_COVER_LETTER") {
      fillCoverLetter({ title: e.data.title, body: e.data.body });
    }
  });

  // Auto-run on page load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
