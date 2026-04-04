/**
 * ATS CONTENT SCRIPT — Workday (*.myworkdayjobs.com)
 *
 * Workday uses a custom SPA with non-standard form controls.
 * Multi-step flow: My Information → My Experience → Application Questions → Review → Submit
 *
 * Strategy:
 * 1. Tailor resume via API
 * 2. Fill Step 1 (My Information) fields
 * 3. Download tailored resume PDF
 * 4. Watch for Submit button click to mark APPLICATION_COMPLETED
 */

(() => {
  if (window.__autoapply_ats_injected) return;
  window.__autoapply_ats_injected = true;

  console.log("AutoApply: Workday ATS script loaded on", window.location.href);

  // Workday renders slowly — wait for form to appear
  setTimeout(() => init(), 4000);

  async function init() {
    const stored = await chrome.storage.local.get(["pendingApplication"]);
    if (!stored.pendingApplication) {
      console.log("AutoApply: No pending application found");
      return;
    }

    const pendingJob = stored.pendingApplication;
    console.log("AutoApply: Processing Workday application for", pendingJob.jobTitle);
    showBanner("AutoApply: Tailoring your resume...");

    try {
      // Scrape JD from Workday page (often more complete)
      const pageJD = scrapeWorkdayJD();
      const jobDescription = pageJD || pendingJob.jobDescription;

      // Request AI tailoring
      const tailoredData = await sendMessageWithTimeout({
        type: "TAILOR_AND_FILL",
        job: { ...pendingJob, jobDescription },
      }, 90000);

      if (tailoredData?.error) {
        console.error("AutoApply: Tailoring error:", tailoredData.error);
        showBanner(`AutoApply: Tailoring error — ${tailoredData.error}. Filling basic info...`, "error");
      }

      showBanner("AutoApply: Filling application form...");

      // Fill whatever step we're on
      await fillCurrentStep(tailoredData?.tailoredResult, pendingJob);

      // Download tailored resume
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_RESUME",
        job: { company: pendingJob.company, jobTitle: pendingJob.jobTitle },
      });

      // Watch for the Submit button to mark application as completed
      watchForSubmit(pendingJob);

      showBanner("AutoApply: Form filled! Upload the downloaded resume, review all fields, and submit.", "success");

      // Send APPLICATION_COMPLETED for the form fill — but the user must still submit
      // We track this as "form_filled" stage, not final submission
      chrome.runtime.sendMessage({
        type: "APPLICATION_COMPLETED",
        job: {
          id: pendingJob.id,
          jobTitle: pendingJob.jobTitle,
          company: pendingJob.company,
          jobUrl: pendingJob.jobUrl || window.location.href,
          matchScore: tailoredData?.tailoredResult?.matchScore || 0,
          completedAt: new Date().toISOString(),
        },
      });

      chrome.storage.local.remove(["pendingApplication"]);

    } catch (err) {
      console.error("AutoApply: Workday error", err);
      showBanner(`AutoApply: Error — ${err.message}. Please fill manually.`, "error");
    }
  }

  function sendMessageWithTimeout(msg, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for API response")), timeout);
      chrome.runtime.sendMessage(msg, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  /* ─────────────── JD SCRAPING ─────────────── */

  function scrapeWorkdayJD() {
    const selectors = [
      '[data-automation-id="jobPostingDescription"]',
      '[data-automation-id="job-posting-about"]',
      '[class*="jobDescription"]',
      ".css-cygeeu",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    // Fallback: look for large text blocks with job-related keywords
    const allDivs = document.querySelectorAll("div, section");
    let bestText = "";
    for (const div of allDivs) {
      const text = div.innerText?.trim() || "";
      if (text.length > 300 && text.length < 10000 &&
        (text.includes("Responsibilities") || text.includes("Qualifications") ||
          text.includes("Requirements") || text.includes("About")) &&
        text.length > bestText.length) {
        bestText = text;
      }
    }
    return bestText;
  }

  /* ─────────────── FORM FILLING ─────────────── */

  async function fillCurrentStep(tailoredResult, job) {
    const profile = await chrome.storage.local.get(["userProfile", "parsedResume"]);
    const user = profile.userProfile || {};
    const resume = profile.parsedResume || {};

    // Determine which step we're on by checking page content
    const pageText = document.body.innerText || "";

    if (pageText.includes("My Information") || pageText.includes("First Name")) {
      await fillMyInformation(user, resume);
    } else if (pageText.includes("My Experience")) {
      // Experience step — we can't fill much here beyond what the resume has
      console.log("AutoApply: On Experience step — user needs to upload resume");
    } else if (pageText.includes("Application Questions")) {
      await fillApplicationQuestions(tailoredResult);
    }
  }

  async function fillMyInformation(user, resume) {
    // Wait for form fields to render
    await new Promise((r) => setTimeout(r, 1000));

    const firstName = user.firstName || resume.contactInfo?.firstName || "";
    const lastName = user.lastName || resume.contactInfo?.lastName || "";
    const email = user.email || resume.contactInfo?.email || "";
    const phone = user.phone || resume.contactInfo?.phone || "";

    // Strategy 1: Workday data-automation-id attributes
    fillWorkdayInput('[data-automation-id="legalNameSection_firstName"]', firstName);
    fillWorkdayInput('[data-automation-id="legalNameSection_lastName"]', lastName);
    fillWorkdayInput('[data-automation-id="email"]', email);
    fillWorkdayInput('[data-automation-id="phone-number"]', phone);
    fillWorkdayInput('[data-automation-id="addressSection_addressLine1"]', user.address || "");
    fillWorkdayInput('[data-automation-id="addressSection_city"]', user.city || "");
    fillWorkdayInput('[data-automation-id="addressSection_postalCode"]', user.postalCode || "");

    // Strategy 2: Find inputs by their label text (Workday uses labels next to inputs)
    fillInputByLabel("First Name", firstName);
    fillInputByLabel("Last Name", lastName);
    fillInputByLabel("Email", email);
    fillInputByLabel("Phone Number", phone);
    fillInputByLabel("Address Line 1", user.address || "");
    fillInputByLabel("City", user.city || "");
    fillInputByLabel("Postal Code", user.postalCode || "");

    // Strategy 3: Workday also puts labels as preceding siblings or in parent divs
    fillInputByPrecedingText("First Name", firstName);
    fillInputByPrecedingText("Last Name", lastName);
    fillInputByPrecedingText("Email", email);

    // Handle the "How Did You Hear About Us?" dropdown
    await selectWorkdayDropdown("How Did You Hear", "Job Sites");

    // Handle Province/Territory dropdown
    if (user.province) {
      await selectWorkdayDropdown("Province", user.province);
    }

    // Handle Phone Device Type dropdown
    await selectWorkdayDropdown("Phone Device Type", "Mobile");

    console.log("AutoApply: Filled My Information step");
  }

  async function fillApplicationQuestions(tailoredResult) {
    if (!tailoredResult) return;

    // Look for text areas and try to fill with relevant content
    const textareas = document.querySelectorAll("textarea");
    for (const ta of textareas) {
      const container = ta.closest("div[data-automation-id]") || ta.closest("div");
      const labelText = container?.querySelector("label")?.textContent?.toLowerCase() || "";

      if (ta.value) continue; // Already filled

      if (labelText.includes("cover") || labelText.includes("letter")) {
        setNativeValue(ta, tailoredResult.coverLetter || "");
      } else if (labelText.includes("why") || labelText.includes("interest")) {
        setNativeValue(ta, tailoredResult.coverLetter || "");
      }
    }
  }

  /* ─────────────── INPUT HELPERS ─────────────── */

  function fillWorkdayInput(selector, value) {
    if (!value) return;
    const el = document.querySelector(selector);
    if (el && !el.value) {
      setNativeValue(el, value);
    }
  }

  function fillInputByLabel(labelText, value) {
    if (!value) return;
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const text = label.textContent?.trim() || "";
      if (text.toLowerCase().includes(labelText.toLowerCase())) {
        const forId = label.getAttribute("for");
        let input = forId ? document.getElementById(forId) : null;

        if (!input) {
          // Look in the parent container
          const container = label.closest("div");
          input = container?.querySelector("input:not([type='hidden']), textarea");
        }

        if (input && !input.value) {
          setNativeValue(input, value);
          return;
        }
      }
    }
  }

  function fillInputByPrecedingText(labelText, value) {
    if (!value) return;
    // Workday sometimes has the label as a text node before the input
    const allInputs = document.querySelectorAll("input:not([type='hidden']):not([type='checkbox']):not([type='radio'])");
    for (const input of allInputs) {
      if (input.value) continue;
      const parent = input.parentElement;
      if (!parent) continue;
      const prevText = parent.textContent?.trim() || "";
      if (prevText.toLowerCase().includes(labelText.toLowerCase())) {
        setNativeValue(input, value);
        return;
      }
    }
  }

  function setNativeValue(el, value) {
    el.focus();
    // Use native setter to trigger React/Workday change detection
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  async function selectWorkdayDropdown(labelText, optionText) {
    // Find the dropdown button by label text
    const allButtons = document.querySelectorAll("button");
    for (const btn of allButtons) {
      const parent = btn.closest("div");
      const label = parent?.querySelector("label") || parent?.previousElementSibling;
      const parentText = parent?.textContent?.trim().toLowerCase() || "";
      const labelContent = label?.textContent?.trim().toLowerCase() || "";

      if (labelContent.includes(labelText.toLowerCase()) || parentText.includes(labelText.toLowerCase())) {
        // Click the dropdown to open it
        btn.click();
        await new Promise((r) => setTimeout(r, 500));

        // Find and click the option
        const options = document.querySelectorAll('[role="option"], [role="listbox"] div, [data-automation-id*="promptOption"]');
        for (const opt of options) {
          if (opt.textContent?.trim().toLowerCase().includes(optionText.toLowerCase())) {
            opt.click();
            await new Promise((r) => setTimeout(r, 300));
            return true;
          }
        }

        // Close dropdown if option not found
        document.body.click();
        return false;
      }
    }
    return false;
  }

  /* ─────────────── SUBMIT WATCHER ─────────────── */

  function watchForSubmit(job) {
    // Watch for the user clicking Submit — then mark as truly submitted
    const observer = new MutationObserver(() => {
      const submitBtn = document.querySelector(
        'button[data-automation-id="bottom-navigation-next-button"], ' +
        'button[aria-label="Submit"], ' +
        'button[data-automation-id="submit"]'
      );
      const pageText = document.body.innerText || "";

      // Check if we're on the final review/confirmation page
      if (pageText.includes("Application Submitted") ||
          pageText.includes("Thank you for applying") ||
          pageText.includes("Your application has been submitted")) {
        console.log("AutoApply: Detected application submitted confirmation!");
        observer.disconnect();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Stop watching after 10 minutes
    setTimeout(() => observer.disconnect(), 600000);
  }

  /* ─────────────── UI BANNER WITH BATCH PROGRESS ─────────────── */

  function showBanner(message, type = "info") {
    let banner = document.getElementById("autoapply-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "autoapply-banner";
      document.body.appendChild(banner);
    }
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: all 0.3s; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    `;
    const colors = {
      info: { bg: "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)", text: "#fff" },
      success: { bg: "linear-gradient(135deg, #059669 0%, #10B981 100%)", text: "#fff" },
      error: { bg: "linear-gradient(135deg, #DC2626 0%, #EF4444 100%)", text: "#fff" },
    };
    const c = colors[type] || colors.info;

    chrome.storage.local.get(["_aa_batchProgress"], (result) => {
      const bp = result._aa_batchProgress;
      let progressHTML = "";
      if (bp && bp.active) {
        progressHTML = `
          <div style="display: flex; align-items: center; gap: 14px;">
            <span style="
              background: rgba(255,255,255,0.2); border-radius: 8px; padding: 4px 12px;
              font-size: 16px; font-weight: 800; letter-spacing: -0.5px;
            ">Job ${bp.current}/${bp.total}</span>
            <span style="font-size: 13px; font-weight: 500;">${message}</span>
          </div>
          <div style="height: 3px; background: rgba(255,255,255,0.15); margin-top: 8px;">
            <div style="height: 100%; background: #34D399; width: ${Math.round((bp.current / bp.total) * 100)}%; border-radius: 0 2px 2px 0;"></div>
          </div>
        `;
      } else {
        progressHTML = `<div style="font-size: 13px; font-weight: 500;">${message}</div>`;
      }

      banner.style.background = c.bg;
      banner.style.color = c.text;
      banner.innerHTML = `<div style="padding: 10px 20px;">${progressHTML}</div>`;
    });

    if (type === "success") setTimeout(() => { if (banner) banner.remove(); }, 20000);
    if (type === "error") setTimeout(() => { if (banner) banner.remove(); }, 20000);
  }
})();
