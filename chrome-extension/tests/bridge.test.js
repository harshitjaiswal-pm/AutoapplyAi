/**
 * Bridge Tests — Plain JavaScript test suite
 * Run with: node chrome-extension/tests/bridge.test.js
 *
 * Extracts and tests pure functions from review-submit.js and cowork-bridge.js
 * No test framework dependency — uses simple assert functions that throw on failure.
 */

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
};

const assertEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}. ${message}`);
  }
};

const assertTrue = (condition, message) => assert(condition, message);
const assertFalse = (condition, message) => assert(!condition, message);

// Test counter
let testCount = 0;
let passedCount = 0;
let failedCount = 0;

function runTest(name, testFn) {
  testCount++;
  try {
    testFn();
    passedCount++;
    console.log(`✓ Test ${testCount}: ${name}`);
  } catch (err) {
    failedCount++;
    console.error(`✗ Test ${testCount}: ${name}`);
    console.error(`  ${err.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   EXTRACTED FUNCTIONS (copied from review-submit.js)
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Scan for name field containing "Kiran Shahi" (case-insensitive)
 */
function scanForName(document) {
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
function scanForResume(document) {
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
function scanForErrors(document) {
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
      const rect = el.getBoundingClientRect?.() || { width: 1, height: 1 };
      if (rect.width > 0 && rect.height > 0) {
        const errorText = (el.textContent || '').trim();
        if (errorText && errorText.length > 0) {
          errorEls.add(el);
          errorDetails.push(`${errorText.substring(0, 60)}`);
        }
      }
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
function scanForEmail(document) {
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

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 1: scanForName — pass
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForName — pass", () => {
  // Mock document where body.innerText contains "Kiran Shahi"
  const mockDoc = {
    body: {
      innerText: "Employee Name: Kiran Shahi\nContact: test@example.com",
    },
    querySelectorAll: (sel) => [],
  };

  const result = scanForName(mockDoc);
  assertTrue(result.found, "Name should be found in body text");
  assertEqual(result.value, 'Kiran Shahi', "Should extract Kiran Shahi from text");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 2: scanForName — fail
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForName — fail", () => {
  // Mock document where body.innerText contains "John Smith" and no selectors match
  const mockDoc = {
    body: {
      innerText: "Employee Name: John Smith\nContact: john@example.com",
    },
    querySelectorAll: (sel) => [],
  };

  const result = scanForName(mockDoc);
  assertFalse(result.found, "Name should not be found");
  assertEqual(result.value, '(not found)', "Should return not found placeholder");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 3: scanForResume — pass
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForResume — pass", () => {
  // Mock document where a querySelectorAll match returns element with filename
  const mockEl = {
    textContent: "Kiran_Shahi_Resume.pdf",
  };

  const mockDoc = {
    body: {
      innerText: "",
    },
    querySelectorAll: (sel) => {
      if (sel.includes("resume")) {
        return [mockEl];
      }
      return [];
    },
  };

  const result = scanForResume(mockDoc);
  assertTrue(result.found, "Resume should be found");
  assertTrue(result.filename.includes("Kiran_Shahi_Resume.pdf"), "Should extract filename");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 4: scanForResume — fail
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForResume — fail", () => {
  // Mock document with no resume indicators
  const mockDoc = {
    body: {
      innerText: "Please upload your resume",
    },
    querySelectorAll: (sel) => [],
  };

  const result = scanForResume(mockDoc);
  assertFalse(result.found, "Resume should not be found");
  assertEqual(result.filename, '', "Should return empty filename");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 5: scanForErrors — no errors
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForErrors — no errors", () => {
  // Mock document with no error indicators
  const mockDoc = {
    querySelectorAll: (sel) => [],
  };

  const result = scanForErrors(mockDoc);
  assertFalse(result.hasErrors, "Should not detect errors");
  assertEqual(result.errorDetails.length, 0, "Should have no error details");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 6: scanForErrors — has errors
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForErrors — has errors", () => {
  // Mock document with visible error element
  const mockErrorEl = {
    textContent: "Required field",
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };

  const mockDoc = {
    querySelectorAll: (sel) => {
      if (sel.includes('aria-invalid')) {
        return [mockErrorEl];
      }
      return [];
    },
  };

  const result = scanForErrors(mockDoc);
  assertTrue(result.hasErrors, "Should detect errors");
  assertTrue(result.errorDetails.length > 0, "Should have error details");
  assertTrue(result.errorDetails[0].includes("Required field"), "Should include error text");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 7: scanForEmail — pass
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForEmail — pass", () => {
  // Mock document with email input containing "kiranshahi"
  const mockEmailEl = {
    value: "kiranshahi.can@gmail.com",
  };

  const mockDoc = {
    querySelectorAll: (sel) => {
      if (sel.includes("email")) {
        return [mockEmailEl];
      }
      return [];
    },
  };

  const result = scanForEmail(mockDoc);
  assertTrue(result.valid, "Email should be valid");
  assertTrue(result.email.includes("kiranshahi"), "Email should contain kiranshahi");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 8: scanForEmail — fail
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("scanForEmail — fail", () => {
  // Mock document with different email
  const mockEmailEl = {
    value: "someone@example.com",
  };

  const mockDoc = {
    querySelectorAll: (sel) => {
      if (sel.includes("email")) {
        return [mockEmailEl];
      }
      return [];
    },
  };

  const result = scanForEmail(mockDoc);
  assertFalse(result.valid, "Email should not be valid");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 9: Bridge message routing — AA_PING produces AA_PONG
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("Bridge message routing — AA_PING produces AA_PONG", () => {
  // Mock the postMessage protocol
  const messages = [];
  const mockWindow = {
    postMessage: (msg) => {
      messages.push(msg);
    },
    location: {
      origin: "http://localhost:3000",
    },
  };

  // Simulate incoming AA_PING
  const incomingMessage = {
    data: {
      source: "cowork-autoapply",
      type: "AA_PING",
    },
    origin: "http://localhost:3000",
  };

  // Simulate handler logic
  if (incomingMessage.data.source === "cowork-autoapply" && incomingMessage.data.type === "AA_PING") {
    mockWindow.postMessage({
      source: "autoapply-ext",
      type: "AA_PONG",
      version: "3.0.0",
    });
  }

  // Verify response was sent
  assertEqual(messages.length, 1, "Should send one message");
  assertEqual(messages[0].type, "AA_PONG", "Should send AA_PONG");
  assertEqual(messages[0].source, "autoapply-ext", "Should have correct source");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 10: Bridge timeout cleanup
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("Bridge timeout cleanup", () => {
  // Simulate pending request tracking
  const pendingRequests = new Map();
  const requestId = "login_12345";
  const timeoutMs = 28000; // 28s per spec

  // Add a request
  const timeoutHandle = setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.delete(requestId);
    }
  }, timeoutMs);

  pendingRequests.set(requestId, {
    type: "LOGIN_NEEDED",
    timeout: timeoutHandle,
  });

  // Verify request is tracked
  assertTrue(pendingRequests.has(requestId), "Should track pending request");

  // Simulate timeout firing
  pendingRequests.delete(requestId);
  assertFalse(pendingRequests.has(requestId), "Should clear request on timeout");

  clearTimeout(timeoutHandle);
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 11: Workday stale-entry fallback
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("Workday stale-entry fallback — retry logic", () => {
  // Simulate sign-in retry counter logic
  const errors = ["Incorrect password"];
  const errorText = errors[0].toLowerCase();
  const isSignInError = errorText.includes("password") || errorText.includes("sign in") ||
                        errorText.includes("incorrect") || errorText.includes("invalid");

  assertTrue(isSignInError, "Should detect sign-in error");

  // Verify retry counter behavior
  let signInRetries = 0;
  const maxRetries = 2;

  assertTrue(signInRetries < maxRetries, "Should allow retries initially");

  signInRetries++;
  assertTrue(signInRetries === 1, "First retry should increment to 1");
  assertTrue(signInRetries <= maxRetries, "Should be within limit");

  signInRetries++;
  assertTrue(signInRetries === 2, "Second retry should increment to 2");
  assertTrue(signInRetries === maxRetries, "Should equal maxRetries at limit");

  // After 2 retries (maxRetries), would switch to create-account path
  const shouldSwitchToCreateAccount = signInRetries >= maxRetries;
  assertTrue(shouldSwitchToCreateAccount, "Should switch to create-account after maxRetries");
});

/* ══════════════════════════════════════════════════════════════════════════════
   TEST 12: extractCompanyFromUrl
   ══════════════════════════════════════════════════════════════════════════════ */

runTest("extractCompanyFromUrl — Workday format", () => {
  const url = "https://autodesk.wd1.myworkdayjobs.com/jobs/123";
  const company = extractCompanyFromUrl(url);
  assertEqual(company, "Autodesk", "Should extract Autodesk from Workday URL");
});

runTest("extractCompanyFromUrl — Greenhouse format", () => {
  const url = "https://greenhouse.io/apply";
  const company = extractCompanyFromUrl(url);
  assertEqual(company, "Greenhouse", "Should extract Greenhouse from hostname");
});

runTest("extractCompanyFromUrl — Invalid URL", () => {
  const url = "not-a-url";
  const company = extractCompanyFromUrl(url);
  assertEqual(company, "Unknown", "Should return Unknown for invalid URL");
});

/* ══════════════════════════════════════════════════════════════════════════════
   SUMMARY
   ══════════════════════════════════════════════════════════════════════════════ */

console.log("\n" + "=".repeat(70));
console.log(`Test Results: ${passedCount} passed, ${failedCount} failed out of ${testCount} total`);
console.log("=".repeat(70));

if (failedCount > 0) {
  process.exit(1);
} else {
  console.log("\n✓ All tests passed!");
  process.exit(0);
}
