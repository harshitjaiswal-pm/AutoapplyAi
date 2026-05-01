/**
 * AutoApply — SAP SuccessFactors ATS Handler
 *
 * Runs on career4.successfactors.com (and *.successfactors.com) application pages.
 *
 * Handles:
 * 1. Profile form filling (name, email, phone, address, country, state, postal)
 * 2. Skillset fields
 * 3. Resume PDF upload via SAP SF's internal SFFileUpload API (bypasses isTrusted restriction)
 * 4. Previous Employment entries
 * 5. Education entries
 *
 * Upload strategy:
 *   SAP SF uses a custom SFFileUpload widget — there is no standard <input type="file">
 *   in the main DOM. We find the SFFileUpload instance on the page, extract its upload
 *   endpoint + query string, then POST the PDF directly via fetch() with session cookies.
 *   The server response is fed back to SFFileUpload.handleResponse() to complete the flow.
 *
 *   As a fallback, we inject a DataTransfer with the PDF file and try dispatching a change
 *   event on whatever file input SAP SF creates internally.
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  const LOG = (...a) => console.log("AutoApply SAP SF:", ...a);
  LOG("SuccessFactors ATS script loaded on", window.location.href);

  // ── Personal details memory (sourced from background via TAILOR_AND_FILL)
  const PROFILE_DEFAULTS = {
    firstName:  "KIRAN",
    lastName:   "SHAHI",
    email:      "kiranshahi.can@gmail.com",
    phone:      "2369796746",
    country:    "Canada",
    state:      "BC",
    city:       "Vancouver",
    street:     "1600M Beach Ave",
    postal:     "V6G 1Y7",
  };

  /* ══════════════════════════════════════════════════════════════════════
   * UTILITY HELPERS
   * ══════════════════════════════════════════════════════════════════════ */

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Fire React/Vue/Framework synthetic change events so the UI updates. */
  function triggerInputChange(el, value) {
    if (!el) return;
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
               || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (proto && proto.set) {
      proto.set.call(el, value);
    } else {
      el.value = value;
    }
    ['input', 'change', 'blur'].forEach(evtName => {
      el.dispatchEvent(new Event(evtName, { bubbles: true }));
    });
  }

  function triggerSelectChange(el, value) {
    if (!el) return;
    // Try matching by value, then by text content
    const opt = Array.from(el.options).find(o => o.value === value || o.text === value || o.text.includes(value));
    if (opt) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  /** Wait until an element matching `selector` exists, up to `timeoutMs`. */
  async function waitForEl(selector, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  /** Scroll element into view and click it. */
  function scrollAndClick(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.click();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * PROFILE FORM FILLING
   * ══════════════════════════════════════════════════════════════════════ */

  async function fillProfileForm(profile) {
    const p = { ...PROFILE_DEFAULTS, ...profile };
    LOG("Filling profile form:", p.firstName, p.lastName);

    await sleep(1000); // wait for SAP SF to finish rendering

    // ── First Name
    const fnInput = document.querySelector('input[id*="firstName"], input[name*="firstName"], input[placeholder*="First"]');
    if (fnInput) { triggerInputChange(fnInput, p.firstName); LOG("✓ First name"); }

    // ── Last Name
    const lnInput = document.querySelector('input[id*="lastName"], input[name*="lastName"], input[placeholder*="Last"]');
    if (lnInput) { triggerInputChange(lnInput, p.lastName); LOG("✓ Last name"); }

    // ── Email
    const emailInput = document.querySelector('input[type="email"], input[id*="email"], input[name*="email"]');
    if (emailInput) { triggerInputChange(emailInput, p.email); LOG("✓ Email"); }

    // ── Phone
    const phoneInput = document.querySelector('input[id*="phone"], input[id*="Phone"], input[name*="phone"]');
    if (phoneInput) { triggerInputChange(phoneInput, p.phone); LOG("✓ Phone"); }

    // ── Country — SAP SF uses a custom combobox; try select first, then click-based
    await fillCountry(p.country);

    // ── State/Province
    await fillStateProvince(p.state);

    // ── Street
    const streetInput = document.querySelector(
      'input[id*="address1"], input[id*="street"], input[id*="Address"], input[name*="address"]'
    );
    if (streetInput) { triggerInputChange(streetInput, p.street); LOG("✓ Street"); }

    // ── City
    const cityInput = document.querySelector('input[id*="city"], input[id*="City"], input[name*="city"]');
    if (cityInput) { triggerInputChange(cityInput, p.city); LOG("✓ City"); }

    // ── Postal Code
    const postalInput = document.querySelector(
      'input[id*="postal"], input[id*="zip"], input[id*="Postal"], input[id*="Zip"]'
    );
    if (postalInput) { triggerInputChange(postalInput, p.postal); LOG("✓ Postal"); }

    LOG("Profile form fill complete");
  }

  async function fillCountry(countryName) {
    // SAP SF may render country as a native <select> or a custom combobox
    // Try native select first
    const countrySelect = document.querySelector(
      'select[id*="country"], select[id*="Country"], select[name*="country"]'
    );
    if (countrySelect) {
      if (triggerSelectChange(countrySelect, countryName)) { LOG("✓ Country (select)"); return; }
    }

    // Try SAP combobox — it renders as an input + dropdown list
    const countryInput = document.querySelector(
      'input[id*="country"], input[id*="Country"]'
    );
    if (countryInput) {
      triggerInputChange(countryInput, countryName);
      await sleep(500);
      // Look for the dropdown option and click it
      const opts = document.querySelectorAll('[class*="listItem"], [role="option"], li[data-key]');
      for (const opt of opts) {
        if (opt.textContent.trim().toLowerCase().includes(countryName.toLowerCase())) {
          opt.click();
          LOG("✓ Country (combobox click)");
          return;
        }
      }
      countryInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
  }

  async function fillStateProvince(stateName) {
    // SAP SF state field: id="88:_input" — native select that opens on click
    // The ID can vary per page; try multiple selectors
    const stateSelectors = [
      'select[id*="state"], select[id*="State"], select[id*="province"], select[id*="Province"]',
      'select[id*=":_input"]',
    ];
    for (const sel of stateSelectors) {
      const stateSelect = document.querySelector(sel);
      if (stateSelect) {
        // Wait a beat for country change to populate the state list
        await sleep(600);
        if (triggerSelectChange(stateSelect, stateName)) {
          LOG("✓ State/Province (select:", stateSelect.id, ")");
          return;
        }
      }
    }

    // Fallback: SAP combobox for state
    const stateInput = document.querySelector('input[id*="state"], input[id*="State"], input[id*="province"]');
    if (stateInput) {
      triggerInputChange(stateInput, stateName);
      await sleep(500);
      const opts = document.querySelectorAll('[class*="listItem"], [role="option"], li');
      for (const opt of opts) {
        const t = opt.textContent.trim();
        if (t === stateName || t.startsWith(stateName + ' ') || t.includes('British Columbia')) {
          opt.click();
          LOG("✓ State/Province (combobox)");
          return;
        }
      }
    }
    LOG("⚠ State/Province not filled — no matching element");
  }

  /* ══════════════════════════════════════════════════════════════════════
   * RESUME PDF UPLOAD
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * Get the tailored resume PDF base64 from the AutoApply extension.
   * Uses the postMessage bridge added to universal.js.
   * Returns { base64, filename } or null.
   */
  function getResumePdfFromExtension() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        LOG("⚠ AA_RESUME_PDF_RESULT timed out");
        resolve(null);
      }, 5000);

      function handler(e) {
        if (e.data?.type === 'AA_RESUME_PDF_RESULT') {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(e.data.base64 ? { base64: e.data.base64, filename: e.data.filename || 'Resume.pdf' } : null);
        }
      }
      window.addEventListener('message', handler);
      window.postMessage({ type: 'AA_GET_RESUME_PDF' }, '*');
    });
  }

  /**
   * Find the SFFileUpload instance on the SAP SF page.
   * SAP SF registers upload components as window globals.
   */
  function findSFFileUpload() {
    // Method 1: scan window globals for the component
    try {
      for (const key of Object.keys(window)) {
        const obj = window[key];
        if (
          obj && typeof obj === 'object' &&
          typeof obj.doUpload === 'function' &&
          typeof obj._getForm === 'function'
        ) {
          LOG("Found SFFileUpload at window." + key);
          return obj;
        }
      }
    } catch (_) {}

    // Method 2: look for elements with SAP SF upload class/ID patterns
    const candidates = document.querySelectorAll('[id*="SFFileUpload"], [id*="fileUpload"], [id*="resume"]');
    for (const el of candidates) {
      if (window[el.id] && typeof window[el.id].doUpload === 'function') {
        LOG("Found SFFileUpload by element id:", el.id);
        return window[el.id];
      }
    }

    // Method 3: check SFLoader / component registry if present
    if (window.sap && window.sap.ui) {
      try {
        const core = window.sap.ui.getCore();
        for (const [id, comp] of Object.entries(core.mElements || {})) {
          if (comp && typeof comp.doUpload === 'function') {
            LOG("Found SFFileUpload in sap.ui.getCore() id:", id);
            return comp;
          }
        }
      } catch (_) {}
    }

    return null;
  }

  /**
   * Upload PDF via SAP SF's internal upload API.
   * Strategy A: direct fetch POST to the upload endpoint.
   * Strategy B: DataTransfer injection with Object.defineProperty override.
   */
  async function uploadResumeViaSAPSF(pdfBase64, pdfFilename) {
    LOG("Starting resume upload, file:", pdfFilename, "base64 length:", pdfBase64?.length);

    // Convert base64 → File object
    const binaryStr = atob(pdfBase64);
    const bytes     = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const pdfFile = new File([bytes], pdfFilename || 'Resume.pdf', { type: 'application/pdf' });

    // ── Strategy A: find SFFileUpload and POST directly to its endpoint
    const sfUpload = findSFFileUpload();
    if (sfUpload) {
      LOG("Strategy A: direct API upload via SFFileUpload");
      try {
        const form = typeof sfUpload._getForm === 'function' ? sfUpload._getForm() : null;
        if (form) {
          const qs        = typeof sfUpload._getQueryString === 'function' ? sfUpload._getQueryString() : '';
          const action    = form.action || form.getAttribute('action') || '';
          const uploadUrl = qs ? `${action}?${qs}` : action;

          LOG("Upload URL:", uploadUrl.substring(0, 120));

          // Build FormData with the file + any hidden fields from the form
          const fd = new FormData();
          const fileInput = form.querySelector('input[type="file"]');
          fd.append(fileInput?.name || 'file', pdfFile);
          form.querySelectorAll('input[type="hidden"]').forEach(inp => {
            if (inp.name) fd.append(inp.name, inp.value);
          });

          const resp = await fetch(uploadUrl, {
            method:      'POST',
            body:        fd,
            credentials: 'include',
          });

          if (resp.ok) {
            const responseText = await resp.text();
            LOG("Upload response (trimmed):", responseText.substring(0, 200));
            if (typeof sfUpload.handleResponse === 'function') {
              sfUpload.handleResponse(responseText);
              LOG("✓ Resume uploaded via Strategy A (handleResponse called)");
              return { success: true, method: 'sfFileUpload_fetch' };
            }
          } else {
            LOG("Strategy A POST failed:", resp.status);
          }
        }
      } catch (err) {
        LOG("Strategy A error:", err.message);
      }
    }

    // ── Strategy B: Object.defineProperty override on the file input
    LOG("Strategy B: DataTransfer + Object.defineProperty override");
    try {
      // SAP SF may not create its file input until the upload area is interacted with
      // Try to find or trigger creation of the file input
      let fileInput = document.querySelector('input[type="file"]');

      // If no file input, click the upload area to trigger SAP SF to create one
      if (!fileInput) {
        const uploadArea = document.querySelector(
          '[class*="SFFileUpload"], [class*="fileUpload"], [id*="upload"], [id*="resume"]'
        );
        if (uploadArea) {
          uploadArea.click();
          await sleep(800);
          fileInput = document.querySelector('input[type="file"]');
        }
      }

      if (fileInput) {
        // Override .files via DataTransfer
        const dt = new DataTransfer();
        dt.items.add(pdfFile);
        Object.defineProperty(fileInput, 'files', {
          value:        dt.files,
          configurable: true,
          writable:     true,
        });
        // Fire change event — SAP SF will read fileInput.files[0]
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);

        // Trigger upload if SFFileUpload is available
        if (sfUpload && typeof sfUpload.doUpload === 'function') {
          sfUpload.doUpload();
          LOG("✓ Resume upload triggered via Strategy B (doUpload)");
          return { success: true, method: 'defineProperty_doUpload' };
        }
        LOG("✓ DataTransfer set, change event dispatched");
        return { success: true, method: 'defineProperty_change' };
      }
    } catch (err) {
      LOG("Strategy B error:", err.message);
    }

    // ── Strategy C: postMessage to AI for manual handling
    LOG("Strategy C: signalling AI that manual upload is needed");
    window.postMessage({
      type:    'AA_RESUME_UPLOAD_NEEDED',
      base64:  pdfBase64,
      filename: pdfFilename || 'Resume.pdf',
      message: 'SAP SF upload blocked — AI should use file_upload tool after saving PDF to disk',
    }, '*');

    return { success: false, method: 'none', needsManual: true };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * MAIN FILL FLOW
   * ══════════════════════════════════════════════════════════════════════ */

  async function fill(job, userProfile) {
    LOG("Starting fill for:", job.jobTitle, "at", job.company);
    showBanner("AutoApply is filling your application…", "ai");

    // Step 1: Fill profile / personal information
    const profile = {
      firstName: userProfile?.firstName || PROFILE_DEFAULTS.firstName,
      lastName:  userProfile?.lastName  || PROFILE_DEFAULTS.lastName,
      email:     userProfile?.email     || PROFILE_DEFAULTS.email,
      phone:     userProfile?.phone     || PROFILE_DEFAULTS.phone,
      country:   userProfile?.country   || PROFILE_DEFAULTS.country,
      state:     userProfile?.state     || PROFILE_DEFAULTS.state,
      city:      userProfile?.city      || PROFILE_DEFAULTS.city,
      street:    userProfile?.street    || PROFILE_DEFAULTS.street,
      postal:    userProfile?.postal    || PROFILE_DEFAULTS.postal,
    };
    await fillProfileForm(profile);
    await sleep(500);

    // Step 2: Upload resume PDF
    showBanner("Uploading tailored resume…", "ai");
    const resumeData = await getResumePdfFromExtension();
    if (resumeData) {
      LOG("Got PDF from extension, uploading. Size:", resumeData.base64.length, "chars");
      const uploadResult = await uploadResumeViaSAPSF(resumeData.base64, resumeData.filename);
      if (uploadResult.success) {
        showBanner("✓ Resume uploaded — filling remaining fields…", "ai");
      } else {
        showBanner("⚠ Resume needs manual upload — continue filling other fields…", "user");
        LOG("Resume upload failed, continuing with other fields");
      }
    } else {
      showBanner("⚠ No tailored resume found — tailor a resume first", "error");
      LOG("No resume PDF found in extension storage");
    }

    await sleep(800);

    // Step 3: Notify completion
    showBanner("✓ AutoApply filled your application — review & submit", "ai");
    LOG("Fill complete for", job.jobTitle);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * BANNER / STATUS UI
   * ══════════════════════════════════════════════════════════════════════ */

  function showBanner(message, type) {
    let banner = document.getElementById("autoapply-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "autoapply-banner";
      banner.style.cssText = `
        all: initial !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        z-index: 2147483647 !important;
        color: #fff !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        padding: 10px 18px !important;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2) !important;
        display: block !important;
        line-height: 1.4 !important;
      `;
      document.body.prepend(banner);
    }
    const bg = type === "error" ? "linear-gradient(135deg,#B91C1C,#DC2626)"
             : type === "user"  ? "linear-gradient(135deg,#B45309,#D97706)"
             :                    "linear-gradient(135deg,#4F46E5,#7C3AED)";
    banner.style.background = bg;
    banner.innerHTML = `
      <div style="display:flex !important;align-items:center !important;gap:8px !important;">
        <span style="font-size:11px !important;font-weight:600 !important;background:rgba(255,255,255,0.18) !important;border-radius:5px !important;padding:2px 8px !important;letter-spacing:0.2px !important;white-space:nowrap !important;color:#fff !important;">✦ AutoApply</span>
        <span style="font-size:13px !important;font-weight:500 !important;color:#fff !important;">${message}</span>
      </div>
    `;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * MESSAGE LISTENER — background.js sends TAILOR_AND_FILL
   * ══════════════════════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "TAILOR_AND_FILL") {
      LOG("TAILOR_AND_FILL received:", message.job?.jobTitle);
      (async () => {
        try {
          await fill(message.job || {}, message.userProfile || {});
          sendResponse({ success: true });
        } catch (err) {
          LOG("Fill error:", err.message);
          showBanner("⚠ AutoApply error: " + err.message, "error");
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // async response
    }

    if (message.type === "SHOW_BANNER") {
      showBanner(message.message || "", message.level === "warn" ? "user" : "ai");
      sendResponse({ ok: true });
      return false;
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
   * AUTO-BOOT: if pendingApplication is set, start filling immediately
   * ══════════════════════════════════════════════════════════════════════ */

  chrome.storage.local.get(["pendingApplication", "userProfile"], async (stored) => {
    const job = stored.pendingApplication;
    if (!job) { LOG("No pendingApplication — waiting for TAILOR_AND_FILL message"); return; }
    LOG("Found pendingApplication — auto-filling:", job.jobTitle);
    // Small delay to let the SAP SF page finish rendering
    await sleep(2000);
    try {
      await fill(job, stored.userProfile || {});
    } catch (err) {
      LOG("Auto-boot fill error:", err.message);
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
   * PHASE D — Apply worker's saved fills onto the live SAP form (PR5)
   *
   * When the user lands on a SAP application form like
   *   https://career17.sapsf.com/portalcareer?career_ns=job_application&career_job_req_id=N&...
   * we:
   *   1. Parse career_job_req_id from the URL → SAP req id
   *   2. Read _aa_userId and _aa_workerToken from chrome.storage.local
   *   3. GET /api/pending-fill?atsHost={hostname}&reqId={N} with auth headers
   *   4. Iterate fill.fields[] and apply each (text / dropdown / screener)
   *   5. Show overlay summary; never click Apply/Submit (user policy)
   *
   * Mirrors worker/steps/runApplication.ts page.evaluate fill_form code.
   * ══════════════════════════════════════════════════════════════════════ */

  function parseSapReqIdFromUrl() {
    try {
      const u = new URL(window.location.href);
      // career_job_req_id is the canonical param. Some SAP variants put it
      // in the URL hash; fall back to scanning all params.
      return u.searchParams.get("career_job_req_id") ||
             u.searchParams.get("jobId") ||
             u.searchParams.get("reqId") ||
             null;
    } catch { return null; }
  }

  function isSapApplicationFormUrl() {
    const href = window.location.href;
    if (!/sapsf\.com|successfactors\./i.test(window.location.hostname)) return false;
    // Workforce / job_application namespace tells us the user is on the
    // application form (not the job listing).
    return /career_ns=job_application|career_job_req_id=/i.test(href);
  }

  /** Find an input/textarea by its associated label text containing matchValue. */
  function findInputByLabelMatch(matchValue) {
    const needle = (matchValue || "").toLowerCase().trim();
    if (!needle) return null;
    const all = Array.from(document.querySelectorAll("input, textarea"));
    return all.find((el) => {
      const lbl = (el.labels && el.labels[0] ? el.labels[0].innerText : "").toLowerCase();
      return lbl.includes(needle);
    }) || null;
  }

  /** Set value via the React-aware native setter — same pattern as worker fill_form. */
  function setSapValue(el, value) {
    if (!el) return false;
    try {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    } catch (err) {
      LOG("setSapValue failed:", err.message);
      return false;
    }
  }

  /** Open a SAP rcmpaginatedselect dropdown by labelMatch and pick the option whose text best matches `answer`. */
  async function pickSapDropdown(labelMatch, answer) {
    const needle = (labelMatch || "").toLowerCase().trim();
    if (!needle) return false;
    const wantedAnswer = (answer || "").toLowerCase().trim();
    const inputs = Array.from(document.querySelectorAll("input.rcmpaginatedselectinput, input"));
    const input = inputs.find((i) => {
      const lbl = (i.labels && i.labels[0] ? i.labels[0].innerText : "").toLowerCase();
      return lbl.includes(needle);
    });
    if (!input) { LOG("dropdown input not found for", labelMatch); return false; }

    if (input.value && input.value.trim() && !/no selection/i.test(input.value)) {
      LOG("dropdown already filled:", labelMatch, "->", input.value);
      return true;
    }

    const button = input.parentElement && input.parentElement.querySelector("button.rcmpaginatedselectbutton");
    if (!button) { LOG("dropdown trigger button not found for", labelMatch); return false; }

    button.click();
    // Poll for popover up to 3s
    for (let i = 0; i < 25; i++) {
      await sleep(120);
      const popovers = Array.from(document.querySelectorAll(".sfoverlaycontainer")).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 50 && r.height > 30;
      });
      if (!popovers.length) continue;
      const items = Array.from(popovers[0].querySelectorAll('a[role="menuitem"], li[role="option"], a'))
        .filter((el) => {
          const t2 = ((el.innerText) || "").trim();
          return t2 && t2.length < 100 && !/no selection/i.test(t2);
        });
      if (items.length === 0) continue;
      // Prefer exact match on answer, fall back to substring contains
      let target = items.find((el) => ((el.innerText) || "").toLowerCase().trim() === wantedAnswer);
      if (!target) target = items.find((el) => ((el.innerText) || "").toLowerCase().includes(wantedAnswer));
      if (!target && items.length > 0) target = items[0]; // last-resort: first real option
      if (target) {
        target.click();
        await sleep(200);
        LOG("dropdown filled:", labelMatch, "->", (target.innerText || "").trim());
        return true;
      }
    }
    LOG("dropdown popover never rendered for", labelMatch);
    document.body.click();
    return false;
  }

  /** Click Yes/No on a SAP screener whose label/question text matches questionText. */
  function answerSapScreener(questionText, answer) {
    const needle = (questionText || "").toLowerCase().trim().slice(0, 40);
    if (!needle) return false;
    const wantNo = /^no$/i.test((answer || "").trim());
    const allFieldDivs = Array.from(
      document.querySelectorAll('[class*="rcmFormQuestion"], [class*="RCMFormField"]')
    ).filter((div) => div.querySelectorAll('.globalRadio.sfRadioInputField, .globalRadio').length >= 2);
    const containers = Array.from(
      document.querySelectorAll(".RCMFormField.rcmFormQuestionElement, .RCMFormField .rcmFormQuestionElement")
    );
    const all = containers.length > 0 ? containers : allFieldDivs;
    for (const container of all) {
      const questionEl = container.querySelector("label, .label, .question, .formLabel, span") || container;
      const q = ((questionEl.innerText) || "").toLowerCase().trim();
      if (!q.includes(needle) && !needle.includes(q.slice(0, 40))) continue;
      const radios = Array.from(container.querySelectorAll(".globalRadio.sfRadioInputField, .globalRadio"));
      const yesRadio = radios.find((r) => /^yes\b/i.test((r.innerText || "").trim()));
      const noRadio  = radios.find((r) => /^no\b/i.test((r.innerText || "").trim()));
      const target = wantNo ? (noRadio || yesRadio) : (yesRadio || noRadio);
      if (!target) continue;
      const innerSpan = target.querySelector(".radioCheck, .radioLabel, label, span");
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
      target.click();
      if (innerSpan) {
        innerSpan.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        innerSpan.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
        innerSpan.click();
      }
      LOG("screener answered:", questionText.slice(0, 50), "->", wantNo ? "No" : "Yes");
      return true;
    }
    return false;
  }

  function showWorkerFillOverlay(filledCount, avgConfidence) {
    if (document.getElementById("aa-worker-fill-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "aa-worker-fill-overlay";
    overlay.style.cssText = [
      "position:fixed", "top:16px", "right:16px", "z-index:2147483640",
      "background:linear-gradient(135deg,#10B981 0%,#059669 100%)",
      "color:#fff", "padding:12px 16px", "border-radius:10px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:13px", "font-weight:600",
      "box-shadow:0 8px 28px rgba(16,185,129,0.42)",
      "max-width:320px",
    ].join(";");
    const confPct = avgConfidence > 0 ? ` · ${Math.round(avgConfidence * 100)}% conf` : "";
    overlay.innerHTML = `
      <div style="font-size:12px;font-weight:700;margin-bottom:4px;">✓ Filled by AutoApply</div>
      <div style="font-size:11px;font-weight:500;opacity:0.92;">${filledCount} field${filledCount === 1 ? "" : "s"} filled${confPct}</div>
      <div style="font-size:11px;font-weight:500;opacity:0.85;margin-top:6px;">Review and click Apply when ready.</div>
    `;
    document.body.appendChild(overlay);
  }

  async function applyWorkerFillsIfPresent() {
    if (!isSapApplicationFormUrl()) return;
    const reqId = parseSapReqIdFromUrl();
    if (!reqId) { LOG("Phase D: no reqId in URL — skipping"); return; }
    const atsHost = window.location.hostname;
    const stored = await new Promise((r) =>
      chrome.storage.local.get(["_aa_userId", "_aa_workerToken", "autoapplyUrl"], r)
    );
    if (!stored._aa_workerToken) {
      LOG("Phase D: _aa_workerToken not set in chrome.storage.local — skipping API call. " +
          "Set via: chrome.storage.local.set({_aa_workerToken: '...', _aa_userId: 'you@email.com'})");
      return;
    }
    if (!stored._aa_userId) {
      LOG("Phase D: _aa_userId not set in chrome.storage.local — skipping API call.");
      return;
    }
    const apiBase = stored.autoapplyUrl || "https://autoapply-ai-delta.vercel.app";
    const url = `${apiBase}/api/pending-fill?atsHost=${encodeURIComponent(atsHost)}&reqId=${encodeURIComponent(reqId)}`;
    LOG("Phase D: GET", url);

    let resp;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: {
          "X-Worker-Token": stored._aa_workerToken,
          "X-User-Id":      stored._aa_userId,
        },
      });
    } catch (err) {
      LOG("Phase D: fetch failed:", err.message);
      return;
    }

    if (resp.status === 404) {
      LOG("Phase D: no pending fill for this user/ats/req — nothing to do");
      return;
    }
    if (!resp.ok) {
      LOG("Phase D: API returned", resp.status);
      return;
    }

    const body = await resp.json().catch(() => ({}));
    if (!body.found || !body.fill || !Array.isArray(body.fill.fields)) {
      LOG("Phase D: API response had no fields:", JSON.stringify(body).slice(0, 200));
      return;
    }

    const fields = body.fill.fields;
    LOG(`Phase D: applying ${fields.length} worker-saved field(s)`);

    let filledCount = 0;
    let totalConf = 0;
    let confSamples = 0;

    for (const f of fields) {
      try {
        let ok = false;
        if (f.kind === "text" && f.matchBy === "labelMatch") {
          const el = findInputByLabelMatch(f.matchValue);
          if (el) ok = setSapValue(el, f.answer);
        } else if (f.kind === "dropdown" && f.matchBy === "labelMatch") {
          ok = await pickSapDropdown(f.matchValue, f.answer);
        } else if (f.kind === "screener" && f.matchBy === "questionText") {
          ok = answerSapScreener(f.matchValue, f.answer);
        } else {
          LOG("Phase D: unsupported field combo:", f.kind, f.matchBy);
        }
        if (ok) {
          filledCount++;
          if (typeof f.confidence === "number") {
            totalConf += f.confidence;
            confSamples++;
          }
        }
      } catch (err) {
        LOG("Phase D: field apply error:", err.message);
      }
    }

    const avgConf = confSamples > 0 ? totalConf / confSamples : 0;
    LOG(`Phase D: done — filled ${filledCount}/${fields.length} (avg conf ${avgConf.toFixed(2)})`);
    if (filledCount > 0) showWorkerFillOverlay(filledCount, avgConf);
  }

  // Run on document_idle entry; also retry once after 2s in case React form
  // hadn't fully rendered the inputs/labels yet.
  (async () => {
    await sleep(1500);
    try { await applyWorkerFillsIfPresent(); } catch (err) { LOG("Phase D init failed:", err.message); }
  })();

})();
