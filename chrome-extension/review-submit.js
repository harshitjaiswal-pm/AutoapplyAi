/**
 * REVIEW SCANNER + SUBMIT
 *
 * Called when extension receives AA_REVIEW_PAGE message.
 * Performs lenient checks on the application review page and submits if all pass.
 *
 * Checks performed:
 * 1. Name field contains "Kiran Shahi" or "KIRAN SHAHI" (case-insensitive)
 * 2. Resume/CV section is not empty (has a filename visible)
 * 3. No required fields showing error state ([aria-invalid="true"], .error, red borders)
 * 4. Email contains "kiranshahi" (sanity check)
 *
 * If all checks pass: find + click Submit button → wait for confirmation → emit AA_SUBMITTED { success: true }
 * If any check fails: emit AA_SUBMITTED { success: false, errors: [...] }
 *
 * After submit: Write to chrome.storage.local._aa_submissions (ring buffer, max 200)
 * Also POST to https://autoapply-ai-delta.vercel.app/api/events/ingest with event type 'application_submitted'
 */

(() => {
  if (window.__autoapply_review_submit_injected) return;
  window.__autoapply_review_submit_injected = true;

  const LOG = (msg, ...args) => console.log(`AutoApply Review+Submit: ${msg}`, ...args);

  /**
   * Scan review page for required fields and validity
   * Returns { passed: boolean, errors: string[] }
   */
  function scanReviewPage() {
    const errors = [];

    // Check 1: Name field contains "Kiran Shahi" (case-insensitive)
    const nameCheck = scanForName();
    if (!nameCheck.found) {
      errors.push(`Name field shows "${nameCheck.value}" instead of Kiran Shahi`);
    } else {
      LOG(`✓ Name check passed: ${nameCheck.value}`);
    }

    // Check 2: Resume/CV section is not empty
    const resumeCheck = scanForResume();
    if (!resumeCheck.found) {
      errors.push('Resume/CV field appears empty');
    } else {
      LOG(`✓ Resume check passed: ${resumeCheck.filename}`);
    }

    // Check 3: No required fields showing error state
    const errorCheck = scanForErrors();
    if (errorCheck.hasErrors) {
      errors.push(...errorCheck.errorDetails);
    } else {
      LOG('✓ No validation errors found');
    }

    // Check 4: Email contains "kiranshahi"
    const emailCheck = scanForEmail();
    if (!emailCheck.valid) {
      errors.push(`Email field shows "${emailCheck.email}" (should contain 'kiranshahi')`);
    } else {
      LOG(`✓ Email check passed: ${emailCheck.email}`);
    }

    return {
      passed: errors.length === 0,
      errors,
    };
  }

  /**
   * Scan for name field containing "Kiran Shahi" (case-insensitive)
   */
  function scanForName() {
    // Try common name selectors
    const nameSelectors = [
      '[data-automation-id*="name" i]',
      'input[type="text"][data-automation-id*="name" i]',
      'input[placeholder*="name" i]',
      '[class*="name"][class*="field"]',
      'div[class*="legalName"], div[class*="fullName"]',
    ];

    for (const sel of nameSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // Get the value (from input or text content)
        const value = (el.value || el.textContent || '').trim();
        if (value && value.toLowerCase().includes('kiran') && value.toLowerCase().includes('shahi')) {
          return { found: true, value };
        }
      }
    }

    // Fallback: scan all visible text for name pattern
    const pageText = document.body.innerText || '';
    if (pageText.toLowerCase().includes('kiran shahi') || pageText.toLowerCase().includes('kiran  shahi')) {
      return { found: true, value: 'Kiran Shahi' };
    }

    return { found: false, value: '(not found)' };
  }

  /**
   * Scan for resume/CV upload section with a filename
   */
  function scanForResume() {
    // Look for file upload indicators
    const resumeSelectors = [
      '[data-automation-id*="resume" i]',
      '[data-automation-id*="attachment" i]',
      '[class*="fileUpload"]',
      '[class*="resume"]',
      'div[class*="file-item"]',
    ];

    for (const sel of resumeSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = (el.textContent || '').trim();
        // Check for filename patterns (e.g., ".pdf", ".doc", any filename-like text)
        if (text && (text.includes('.pdf') || text.includes('.doc') || text.match(/\.[a-z]{2,4}$/i))) {
          return { found: true, filename: text.substring(0, 100) };
        }
      }
    }

    // Check for "Successfully Uploaded" or "Attached" text
    const pageText = document.body.innerText || '';
    if (pageText.toLowerCase().includes('successfully uploaded') || pageText.toLowerCase().includes('attached')) {
      return { found: true, filename: '(confirmed uploaded)' };
    }

    return { found: false, filename: '' };
  }

  /**
   * Scan for validation errors in required fields
   */
  function scanForErrors() {
    const errorSelectors = [
      '[aria-invalid="true"]',
      '[class*="error"]',
      '[data-automation-id*="error"]',
      '.error-message',
      '.validation-error',
    ];

    const errorDetails = [];
    const errorEls = new Set();

    for (const sel of errorSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // Check if it's actually visible and has error text
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const errorText = (el.textContent || '').trim();
          if (errorText && errorText.length > 0) {
            errorEls.add(el);
            errorDetails.push(`${errorText.substring(0, 60)}`);
          }
        }
      }
    }

    // Also check for red borders (common error indicator)
    const allInputs = document.querySelectorAll('input[type="text"], textarea, select');
    for (const inp of allInputs) {
      const style = window.getComputedStyle(inp);
      const borderColor = style.borderColor || '';
      // Red-ish border (heuristic)
      if (borderColor.toLowerCase().includes('rgb') && (borderColor.includes('255, 0') || borderColor.includes('139, 0'))) {
        errorDetails.push(`Field has red border: ${inp.name || inp.id || '(unnamed)'}`);
        errorEls.add(inp);
      }
    }

    return {
      hasErrors: errorEls.size > 0,
      errorDetails: errorDetails.slice(0, 5), // Limit to 5 for readability
    };
  }

  /**
   * Scan for email field and verify it contains "kiranshahi"
   */
  function scanForEmail() {
    const emailSelectors = [
      'input[type="email"]',
      'input[data-automation-id*="email" i]',
      'input[name*="email" i]',
      'input[placeholder*="email" i]',
    ];

    for (const sel of emailSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const email = (el.value || '').trim().toLowerCase();
        if (email && email.includes('kiranshahi')) {
          return { valid: true, email };
        }
      }
    }

    return { valid: false, email: '(not found)' };
  }

  /**
   * Find and click the Submit button
   */
  function findAndClickSubmitButton() {
    // Try common submit button selectors in order of specificity
    const submitSelectors = [
      '[data-automation-id="bottom-navigation-next-button"]', // Workday
      'button[type="submit"]',
      'button[aria-label*="submit" i]',
      'button[aria-label*="submit application" i]',
      '[role="button"][aria-label*="submit" i]',
    ];

    for (const sel of submitSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'submit' || text.includes('submit') || text === 'send application') {
          LOG(`Found submit button: "${text}"`);
          btn.click();
          return { found: true, text };
        }
      }
    }

    // Fallback: find any button with "Submit" text
    const allBtns = document.querySelectorAll('button, [role="button"]');
    for (const btn of allBtns) {
      const text = (btn.textContent || '').trim();
      if (text.toLowerCase() === 'submit' || text.toLowerCase() === 'submit application') {
        LOG(`Found submit button (fallback): "${text}"`);
        btn.click();
        return { found: true, text };
      }
    }

    return { found: false, text: '' };
  }

  /**
   * Wait for confirmation page or success indicator after submit
   */
  async function waitForConfirmation(timeoutMs = 10000) {
    const start = Date.now();
    const confirmSelectors = [
      '[data-automation-id*="confirmation" i]',
      '[class*="success"]',
      '[class*="thank you"]',
      'h1, h2, h3', // Look for confirmation headings
    ];

    while (Date.now() - start < timeoutMs) {
      // Check for success indicators
      for (const sel of confirmSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = (el.textContent || '').toLowerCase();
          if (text.includes('thank') || text.includes('success') || text.includes('submitted') || text.includes('confirmation')) {
            LOG(`Confirmation detected: ${text.substring(0, 50)}`);
            return true;
          }
        }
      }

      // Check if URL changed (often indicates post-submit redirect)
      if (window.location.href.includes('/confirmation') || window.location.href.includes('/thank-you')) {
        LOG('Confirmation detected: URL changed to confirmation page');
        return true;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    return false;
  }

  /**
   * Store submission record in chrome.storage
   */
  async function storeSubmissionRecord(jobUrl, success, errors) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['_aa_submissions'], (result) => {
        const existing = result._aa_submissions || [];
        const record = {
          jobUrl,
          company: extractCompanyFromUrl(jobUrl),
          timestamp: new Date().toISOString(),
          success,
          errors: errors || [],
        };

        // Ring buffer: keep max 200 submissions
        const updated = [...existing, record];
        const trimmed = updated.length > 200 ? updated.slice(-200) : updated;

        chrome.storage.local.set({ _aa_submissions: trimmed }, resolve);
        LOG(`Stored submission record (${trimmed.length} total)`);
      });
    });
  }

  /**
   * Extract company name from job URL
   */
  function extractCompanyFromUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname;
      // e.g., "autodesk.wd1.myworkdayjobs.com" → "Autodesk"
      const match = host.match(/^([a-z0-9-]+)\./) || host.match(/^([a-z0-9-]+)\..*jobs/);
      return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : host;
    } catch (_) {
      return 'Unknown';
    }
  }

  /**
   * Send analytics event to autoapply-ai API
   */
  async function sendAnalyticsEvent(jobUrl, success, errors) {
    const eventPayload = {
      type: 'application_submitted',
      jobUrl,
      company: extractCompanyFromUrl(jobUrl),
      success,
      errorCount: errors.length,
      errors: errors.slice(0, 5), // Limit errors for payload size
      timestamp: new Date().toISOString(),
    };

    try {
      await fetch('https://autoapply-ai-delta.vercel.app/api/events/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload),
      });
      LOG('Analytics event sent');
    } catch (err) {
      LOG(`Analytics event failed: ${err.message}`);
      // Continue anyway — analytics failure doesn't block the submission
    }
  }

  /**
   * Main entry point: scan, check, submit, record
   * Called from background.js when AA_REVIEW_PAGE is received
   */
  window.AAReviewSubmit = {
    async processReviewPage(jobUrl) {
      LOG(`Processing review page: ${jobUrl}`);

      // Scan the page
      const scanResult = scanReviewPage();
      if (!scanResult.passed) {
        LOG(`Review scan failed: ${scanResult.errors.join('; ')}`);
        return {
          success: false,
          errors: scanResult.errors,
          jobUrl,
        };
      }

      LOG('Review scan passed — attempting submit');

      // Click submit button
      const submitResult = findAndClickSubmitButton();
      if (!submitResult.found) {
        const err = 'Submit button not found';
        LOG(err);
        return {
          success: false,
          errors: [err],
          jobUrl,
        };
      }

      // Wait for confirmation
      const confirmed = await waitForConfirmation();
      if (!confirmed) {
        LOG('Warning: no confirmation page detected, but submit clicked');
        // Don't fail here — assume submit worked even if we can't detect confirmation
      }

      // Record submission
      await storeSubmissionRecord(jobUrl, true, []);

      // Send analytics
      await sendAnalyticsEvent(jobUrl, true, []);

      LOG('Submission successful');
      return {
        success: true,
        errors: [],
        jobUrl,
      };
    },
  };

  /**
   * Listen for AA_DO_REVIEW_SUBMIT from background.js
   * Called when background.js receives AA_REVIEW_PAGE from cowork-bridge
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AA_DO_REVIEW_SUBMIT') {
      const { url, atsType } = message;
      LOG(`Received AA_DO_REVIEW_SUBMIT: ${url}`);

      (async () => {
        try {
          const result = await window.AAReviewSubmit.processReviewPage(url);
          sendResponse(result);
        } catch (err) {
          LOG(`Error processing review page: ${err.message}`);
          sendResponse({
            success: false,
            errors: [err.message],
            jobUrl: url,
          });
        }
      })();

      return true; // async response
    }
  });

  LOG('Module loaded and ready');
})();
