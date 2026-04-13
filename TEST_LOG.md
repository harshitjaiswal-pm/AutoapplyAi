# AutoApply AI — Test Log

---

## Cycle 1 — Mon Apr 13, 2026

### Pre-Flight Status
| Check | Result |
|-------|--------|
| Extension loaded from correct path (`chrome-extension/`) | ✅ Confirmed |
| localhost:3000 running | ✅ Confirmed (npm run dev visible in Terminal) |
| Manifest URL patterns | ✅ All 10 required patterns present (wd1-wd12, LinkedIn, Greenhouse, Lever, iCIMS, SmartRecruiters, Ashby) |

---

### CF1 — Tailored Resume Availability

#### CF1-1A: parse-resume API
- Status: **PENDING LIVE TEST** (localhost not reachable from sandbox; test-cf1.sh must run in separate terminal tab)
- Code audit result: ✅ Fixed — schema validation added, 20-word minimum check, 30s timeout
- Bug fixed: Weak length check (50 chars vs 20 words) → now uses word count

#### CF1-1B: analyze-job API
- Status: **PENDING LIVE TEST**
- Code audit result: ✅ Fixed — schema guard added (requires title/skills/requirements), 30s timeout
- Prior issue: empty response not handled → now returns 422 with user-facing error

#### CF1-1C: tailor-resume quality
- Status: **PENDING LIVE TEST**
- Code audit result: ✅ Fixed — pre-parse JSON check added, schema guard (requires experience or tailoredResume), 90s timeout
- Prompt fix: name/email/phone added to SACRED rule and MUST NEVER DO list

#### CF1-1D: Correct resume stored/retrieved per job
- **BUG FIXED: Silent download block (BUG-CF1-1D-BANNER)**
  - Root cause: `handleDownloadResume()` called `return` when PDF not found, with no user-facing notification
  - Fix: `callerTabId` now passed to `handleDownloadResume()`; sends `SHOW_BANNER` message to panel
  - Fix: `content.js` now has `chrome.runtime.onMessage` listener that renders amber/red/green banner at top of panel, auto-dismisses in 8s
- **BUG FIXED: Map entry missing resumeKey (BUG-CF1-1D-KEY)**
  - Root cause: stored `tailoredResumeMap` entries didn't carry their own key for self-identification
  - Fix: `resumeKey` field added to `entryPayload` in `background.js` line ~2171
- Wrong-resume fallback guard: ✅ Already fixed in prior session (`globalMatchesCurrent` check)

#### CF1-1E: Resume availability across browser sessions
- Status: **PENDING LIVE TEST** (requires manual browser restart test)
- Code audit: ✅ Storage uses `chrome.storage.local` (persists across sessions), not in-memory

---

### CF2 — Form Filling Across All Platforms

#### CF2 Pre-Check: Manifest Coverage
| Platform | URL Pattern | Status |
|----------|-------------|--------|
| LinkedIn | `*://www.linkedin.com/jobs/*` | ✅ Present |
| Workday wd1-wd5 | `*://*.wd1-wd5.myworkdayjobs.com/*` | ✅ All present |
| Workday wd10, wd12 | `*://*.wd10.myworkdayjobs.com/*`, `*://*.wd12.myworkdayjobs.com/*` | ✅ Present |
| Greenhouse (boards) | `*://boards.greenhouse.io/*` | ✅ Present |
| Greenhouse (job-boards) | `*://job-boards.greenhouse.io/*` | ✅ Present |
| Lever | `*://jobs.lever.co/*` | ✅ Present |
| SmartRecruiters | `*://jobs.smartrecruiters.com/*` | ✅ Present |
| Ashby | `*://*.ashbyhq.com/*` | ✅ Present |
| iCIMS | `*://*.icims.com/*` | ✅ Present |

#### CF2 Auto-Submit Safety Audit (ALL PASS — ZERO TOLERANCE MET)
| Platform | File | Auto-Submit Risk | Result |
|----------|------|-----------------|--------|
| LinkedIn | `content.js` lines 1537-1578 | Finds Submit button, pulses it visually, STOPS — user clicks | ✅ SAFE |
| Workday | `ats/workday.js` `watchForSubmit()` | MutationObserver only — no click | ✅ SAFE |
| Greenhouse | `ats/greenhouse.js` `watchForSubmit()` | MutationObserver only — no click | ✅ SAFE |
| Lever | `ats/lever.js` | Shows banner "Your turn — review and submit" — no click | ✅ SAFE |
| Generic/Ashby | `ats/generic.js` `autoAdvancePages()` | Explicitly stops when `FINAL_TEXTS` detected — no submit click | ✅ SAFE |

#### CF2-2A: LinkedIn Easy Apply — **PENDING LIVE TEST**
- Panel mismatch guard: In code at `startApplying()`, panelMismatch is logged — **user-facing message needs verification**
- City typeahead: In code — needs live test on real job

#### CF2-2B: Workday — **PENDING LIVE TEST**
- Subdomain coverage: All wd1-wd12 in manifest ✅
- Numeric field validation loop: Known risk area — needs live test

#### CF2-2C: Greenhouse — **PENDING LIVE TEST**
#### CF2-2D: Lever — **PENDING LIVE TEST**
#### CF2-2E: Generic/Ashby — **PENDING LIVE TEST** (prior session showed Ceipal Ashby panel visible)

---

### Bugs Found This Cycle
| # | Severity | File | Description | Status |
|---|----------|------|-------------|--------|
| B1 | CRITICAL | `prompts.ts` line 131 | name/email/phone missing from SACRED rule | ✅ FIXED |
| B2 | HIGH | `background.js` ~2171 | resumeKey missing from stored map entries | ✅ FIXED |
| B3 | CRITICAL | `background.js` ~2401 | Blocked download silently returns — no user message | ✅ FIXED |
| B4 | CRITICAL | `content.js` EOF | No `onMessage` listener — panel couldn't receive background messages | ✅ FIXED |
| B5 | HIGH | `parse-resume/route.ts` | Weak word-count check, no schema validation, no timeout | ✅ FIXED |
| B6 | HIGH | `analyze-job/route.ts` | No schema validation, no timeout | ✅ FIXED |
| B7 | HIGH | `tailor-resume/route.ts` | No pre-parse check, no schema validation, no timeout | ✅ FIXED |

### Bugs Pending Live Verification
| # | Severity | Description | Where to Test |
|---|----------|-------------|---------------|
| B8 | MEDIUM | LinkedIn panelMismatch — no user-facing message shown | Open LinkedIn Easy Apply, trigger on mismatched job |
| B9 | MEDIUM | Workday numeric field validation loop | Open Workday application, check years-of-experience field |
| B10 | LOW | CF1-1E: Resume survives browser restart | Tailor, close browser, reopen, download |

---

### Git Status
| Item | Status |
|------|--------|
| Commits to push | 6 files modified, 113 insertions — **PENDING PUSH** (auto-push.sh git lock conflicts) |
| Push method | Run: `pkill -f auto-push.sh && rm -f .git/index.lock .git/HEAD.lock && git add -A && git commit && git push` |

---

## Next Cycle Actions
1. Run `test-cf1.sh` in new terminal tab (npm dev must stay in its own tab)
2. Live test on LinkedIn Easy Apply — verify panelMismatch user message
3. Live test on Workday — verify numeric field + city typeahead
4. Verify resume survives browser restart (CF1-1E)
5. Push all fixes cleanly

## Cycle 1 — CF1 API Tests — Mon 13 Apr 2026 08:14:40 PDT
CF1-1A parse-resume: See terminal output above
CF1-1B analyze-job: See terminal output above
CF1-1C tailor-resume: See terminal output above
Results: 1 passed / 0 failed

---

## Cycle 2 — Mon 13 Apr 2026, 13:40 PDT — Async Risk Audit

**Trigger:** User was debugging Taleo form fill (Just Energy @ justenergy.taleo.net); found root cause: `*.taleo.net` was missing from manifest `content_scripts`, so `generic.js` never loaded on Taleo pages.

### Bugs Fixed
| # | Severity | File | Description | Status |
|---|----------|------|-------------|--------|
| B11 | CRITICAL | `chrome-extension/manifest.json` | `*.taleo.net` missing from content_scripts — generic.js never ran on Taleo; no Taleo-specific fill logic executed | ✅ FIXED commit `0904540` |

### Deliverable
**`USER_JOURNEY_RISK_REPORT.md`** written to workspace root. Maps all 14 user-journey stages to traffic-light risk levels. Summary:
- 🟢 LOW-risk (trust): stages 1, 2, 3, 6, 8, 9, 11 (7 of 14)
- 🟡 MEDIUM-risk (watch): stages 4, 5, 7, 10, 12, 13 (6 of 14)
- ✅ Safety invariant (stage 14 — no auto-submit): HOLDS on all platforms
- 🔴 HIGH/CRITICAL: none

### Open Medium-Risk Items (ranked by lift-for-effort)
1. **Tailoring date mutation unguarded** — `tailor-resume/route.ts:115-123`. Add post-response validator. ~20 min.
2. **Batch-mode stale PDF fallback** — `workday.js:64`, `greenhouse.js:64`. Strip `tailoredResumePdf` global fallback. ~30 min.
3. **Custom Q API missing JD** — `answer-custom-question/route.ts:16-46`. Pass JD text. ~45 min.
4. **Workday "Use My Last Application"** — force fresh-start path. ~15 min.
5. **`expectingNewTab` flag loose on custom domains** — `background.js:160-165`. Scope to host. ~20 min.
6. **Ashby iframe silent timeout** — `generic.js:142-158`. Show user banner on timeout. ~10 min.

### Next Cycle Priority
Live-verify the Taleo fix on `justenergy.taleo.net` (extension already reloaded). Form should now fill First Name, Last Name, Street Address, Zip/Postal Code, Primary Number. If not, check page DevTools console for `generic.js` log lines.
