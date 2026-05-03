# Autonomous loop — 18-hour Workday end-to-end build

**Started:** 2026-05-01 17:25 PT  
**ETA:** 2026-05-02 ~11:25 PT  
**Goal:** Workday anon-apply end-to-end via worker + dashboard review view, run against the 10 reviewed Workday URLs.

This file is appended-to as I go. Peek anytime. Final summary will be in `MORNING_REVIEW.md`.

---

## Hour 0 — startup (in progress)

- ✅ Cloned `autoapply-worker` to `C:\dev\autoapply-worker` (Playwright + BullMQ + Upstash + Zod, more built-out than expected).
- ✅ Verified Redis access from local machine. Kiran's master resume key (`user:kiranshahi.can@gmail.com:resume`) returns 6366 chars of `resumeText`, savedAt 2026-05-01T15:22Z (her morning re-upload).
- ⚠️ **Finding #1**: `parsedResumeSummary` in Kiran's stored resume is empty (`name=''`, `jobCount=0`, `skillCount=0`). The /onboarding flow saved raw text but never populated the structured summary. Worker will fall back to `resumeText` directly. Documenting for AM review.
- ⚠️ **Security**: `.git/config` in autoapply-ai has a GitHub PAT in plaintext URL. Flagged in chat — Harshit to rotate when back.
- 🟡 **Decisions made** (full table in chat):
  - Account creation: SKIP for v1, anon-apply tenants only
  - Gmail/OTP: SKIP (falls out of skip-account-creation)
  - Real submit: STUBBED (button sets status=`submitted_stubbed`)
  - Trace storage: structured JSON in Redis + screenshots to Vercel `/public/traces/{appId}/`
  - Demo bar: 10 URLs through pipeline, dashboard renders, mixed pass/fail with diagnostic trace per job

Next: read every file in autoapply-worker, identify gaps, write `WORKER_AUDIT.md`.

---

## Hour 0.5 — Step 1 done (probe)

- ✅ Installed Playwright (Python). Wrote 3 probe scripts. Ran 3 passes.
- ✅ **Hard finding: ZERO anon-apply Workday tenants in the queue.** All 10 reviewed URLs hit a Create Account wall. Documented in `WORKDAY_FEASIBILITY.md`.
- ⚠️ **This blocks Step 3 (Workday adapter for anon-apply tenants)** — there are no anon-apply tenants. Step 3 paused, will need account-creation flow OR a pivot to Greenhouse/Ashby URLs.
- 🟡 **Conservative default per loop rules**: proceed with Steps 2, 4, 5 (all ATS-agnostic). Step 3 surfaced to Harshit in `WORKDAY_FEASIBILITY.md` for the morning call.
- Per-URL findings + screenshots in `C:\Users\harsh\Downloads\workday_probe\`.

## Hour 0.5+ — Step 2 (dashboard) — DONE

- ✅ Built `GET /api/applications` (lists user's audit records by reading `user:{email}:applications` list, fetching each `audit:{id}` blob)
- ✅ Built `GET /api/applications/[id]` (full audit detail) and `POST /api/applications/[id]` with `action=approve_stub` (sets `status=submitted_stubbed`)
- ✅ Built `/dashboard/applications` list page (table with status badges, cost, duration, last-updated)
- ✅ Built `/dashboard/applications/[id]` detail page (tailored resume preview iframe, Q&A table with flagged-for-human chips, step trace cards with inline screenshots, Approve&Submit button stubbed)
- ✅ Seeded 3 mock audit records in Redis (`app-mock-001` completed, `app-mock-002` in_progress, `app-mock-003` failed at Create Account wall — directly references the Step 1 finding)
- ✅ TypeScript compiles clean (`npx tsc --noEmit` exit 0)
- ✅ Committed + pushed to branch **`harshit/loop-step2-dashboard`**. Vercel will preview-deploy automatically.

**Branch**: `harshit/loop-step2-dashboard`  
**Pull request URL** (to create when reviewing): https://github.com/harshitjaiswal-pm/AutoapplyAi/pull/new/harshit/loop-step2-dashboard

## Hour 1+ — Step 4 (DOCX export wiring) — DONE

- ✅ Modified `worker/steps/tailorResume.ts` to call `/api/export-resume?format=docx` after `/api/tailor-resume` and upload the .docx binary to R2 alongside the JSON.
- ✅ Step output now includes three new fields: `resumeJsonUrl`, `resumeDocxUrl`, `docxExportError`. Legacy `resumeArtifactUrl` aliases the .docx (or falls back to JSON) so existing callers keep working.
- ✅ Updated `runApplication.ts` to surface those fields in the `output` of the `tailor_resume` audit step → dashboard sees them.
- ✅ Added `.gitignore` to autoapply-worker (it didn't have one).
- ✅ Committed + pushed to **`harshit/step4-docx-export`** on `harshitjaiswal-pm/autoapply-worker`. 3-file diff, clean.

**Worker branch:** `harshit/step4-docx-export`  
**Worker PR:** https://github.com/harshitjaiswal-pm/autoapply-worker/pull/new/harshit/step4-docx-export

⚠️ Pre-existing TS errors in `runner.ts` and `runApplication.ts` `page.evaluate` blocks remain. They are missing DOM types for browser context — runtime is fine because tsx doesn't typecheck. Worth a separate cleanup PR but not blocking.

## Hour 1.5+ — Step 5 (resume parse) — DONE

- ✅ Wrote `scripts/parse_kiran_resume.py`: reads `user:kiranshahi.can@gmail.com:resume` from Upstash, POSTs `resumeText` to Vercel `/api/parse-resume`, gets structured Claude Haiku output, writes full StoredResume back with populated `parsedResumeSummary`.
- ✅ Ran end-to-end successfully:
  - Before: `name='', jobCount=0, skillCount=0`
  - After: `name='Kiran Shahi', jobCount=5, skillCount=52`
- ✅ The 5 jobs match her actual master resume (The Brick, Fractal, Infosys ×3).
- ✅ Idempotent — re-running just refreshes the parse with current API behavior.

## Hour 2 — Loop wrapping up

Steps complete: 1, 2, 4, 5. Step 3 blocked (zero anon-apply Workday tenants). Per loop rules ("stop after step 5"), no further wake-ups. Writing `MORNING_REVIEW.md` next.

---

## Day 2 — Phase A1 (account creation flow)

### A1.1 — Gmail OAuth scope on NextAuth ✅
- Added `gmail.readonly` to NextAuth Google provider; `access_type=offline` + `prompt=consent` for refresh token.
- jwt callback persists access_token + refresh_token to Upstash under `user:{email}:google_tokens`.
- Hit a real bug: `src/app/api/auth/[...nextauth]/route.ts` had its OWN inline NextAuth config that didn't import `authOptions`. Sign-in flow was using the wrong config — all my scope/jwt-callback changes were silently dropped. Fixed in PR #24.
- Diagnostic-only PR #23 logged 6 jwt invocations all with `hasAccount=false`, which made the bug visible.

### A1.2 — Worker Gmail helper ✅
- New `gmail.ts` in autoapply-worker: `getAccessToken` (auto-refreshes via Google token endpoint), `searchInbox`, `getMessage`, `findOtpOrLink` (heuristic OTP + verification-URL extractor), `waitForVerificationEmail` (polling loop with timeout).
- Pushed to `harshit/gmail-helper` branch.

### A1.3 — Consent flow + tokens captured ✅
- After fix in PR #24, Kiran went through full OAuth in Incognito.
- Google's "unverified app" warning appeared (expected — Gmail-readonly is sensitive scope). Click-through Continue → Allow.
- Tokens in Redis: `scope: openid userinfo.email userinfo.profile gmail.readonly`, both access + refresh tokens stored.
- End-to-end flow proven from sign-in → Redis → Gmail API call (validated server-side).

### A1.4 — createAccount worker step ✅ (dry-run validated)
- New `steps/createAccount.ts` in autoapply-worker.
- Walks Apply → Apply-Manually → Create-Account form on a Workday tenant.
- Stable Workday selectors: `[data-automation-id="adventureButton" / "applyManually" / "email" / "password" / "verifyPassword" / "createAccountCheckbox" / "createAccountSubmitButton"]`.
- Important: avoids `[data-automation-id="beecatcher"]` (honeypot field).
- Per-tenant deterministic password: HMAC-SHA256(masterSecret, `${tenant}|${email}`) → `Aa1!{hex16}X#`.
- Stores credentials under `user:{email}:tenant_creds:{tenantHost}` in Upstash.
- `dryRun: true` mode fills form but skips Submit; pre-submit screenshot captured.
- **Smoke test on UBC: PASSED in 12 seconds.** All 4 form fields filled correctly, honeypot avoided, ready for real submit.
- Branch: `harshit/step-a1.4-create-account` on autoapply-worker.

## Next: A1.5 (wait_for_otp) and A1.6 (enter_otp)

A1.5 will use the gmail.ts helper to poll Kiran's inbox after Submit. A1.6 will either click the verification link in a fresh tab OR type the OTP into a "Verify Email" page if Workday shows one.

A1.7 — the real end-to-end smoke that creates a UBC account — requires Harshit's explicit "yes, run it for real" because it's an irreversible side-effect (a real account at UBC under Kiran's email).

---

## Phase A2 — LLM-driven wizard walker — 8/10 SUBMITTED ✅

**Run timestamp:** 2026-05-03 (overnight batch + targeted rerun)
**Branch:** `harshit/step-a1.7-orchestrator` on autoapply-worker
**Original run:** `logs/queue-run-2026-05-03T10-23-31-788Z/` (5/10 submitted)
**Stuck-URL rerun:** `logs/queue-rerun-20260503-035724/` (3 more submitted)

### Final 10-URL summary table (after stuck-URL rerun with auth recovery)

| # | Tenant | Title | Status | Steps | applicationId | atsEmail | Stop reason |
|---|--------|-------|--------|-------|---------------|----------|-------------|
| 1 | ubc | Senior Business Analyst | ✅ **submitted** | 6/6 | 862a635e | +ubc-wd10-862a635e | submitted; confirmation reached (signInIfNeeded recovery worked after esbuild __name shim) |
| 2 | canadiantirecorporation | Category Business Analyst (Evergreen) | ✅ **submitted** | 5/5 | 91f6cc00 | +canadiantirecorporation-wd3-91f6cc | submitted; confirmation reached |
| 3 | canadiantirecorporation | Category Business Analyst | ✅ **submitted** | 5/5 | 90751a89 | +canadiantirecorporation-wd3-90751a | submitted; confirmation reached |
| 4 | langara | Intermediate Business Analyst | ✅ **submitted** | 5/5 | b43d2cb2 | +langara-wd10-b43d2cb2 | submitted; confirmation reached |
| 5 | canadiantirecorporation | Senior Business Analyst | ✅ **submitted** | 5/5 | 29685fa4 | +canadiantirecorporation-wd3-29685f | submitted; confirmation reached |
| 6 | fil | Business Analyst | 🟠 stuck (rerun also failed) | 0/1 | 25665ca4 | +fil-wd3-25665ca4 | createAccount mis-classifies as auto_logged_in even when page still on Create Account form; sign-in then fails because account never actually got created |
| 7 | quadreal | Business Analyst, Anaplan | ✅ **submitted** | 5/5 | 3ff1731f | +quadreal-wd10-3ff1731f | submitted; confirmation reached (signInIfNeeded recovery worked) |
| 8 | fednav | Business Analyst, IT | ✅ **submitted** | 4/4 | a270329b | +fednav-wd3-a270329b | submitted; confirmation reached |
| 9 | quadreal | Senior Technical Business Analyst | ✅ **submitted** | 5/5 | 897b0026 | +quadreal-wd10-897b0026 | submitted; confirmation reached (signInIfNeeded recovery worked) |
| 10 | bestbuycanada | Business Analyst II (1-year contract) | ❌ error | 0/0 | d209c08a | +bestbuycanada-wd3-d209c08a | "Apply button not found on JD page" — Best Buy renders the Apply button outside the standard `[data-automation-id="adventureButton"]` selector chain; needs Best Buy-specific JD DOM probe |

**Headline: 8/10 unique URLs fully submitted to real Workday tenants** with Kiran's master `.docx` resume + LLM-tailored answers per JD. Each `+tag` email aliases to her actual Gmail so confirmation messages will arrive.

### Code patches pushed (commit log on `harshit/step-a1.7-orchestrator`)

All committed under that branch with descriptive messages:

1. **`886d324`** — A1.7: cascading walker uses Playwright clicks (real mouse events). Fixed "How Did You Hear About Us?" two-level menu (Social Network → LinkedIn).
2. **`4ae71e0`** — A1.7: fix Province (listbox-button) + Yes/No (opacity-0 radios). Province widget is a `<button aria-haspopup="listbox">` distinct from the multi-select widget; previous code double-clicked it. Native radio inputs were rejected by introspector's `isVisible()` because they're hidden behind styled circles.
3. **`4c25e73`** — A1.7: per-strategy radio verification + SPA advance detection. Six radio click strategies tried in priority with per-step `input.checked` verification. Walker now compares page header (not just URL/title) since Workday wizards keep URL constant.
4. **`19ab57b`** — A1.7: pageHeader detects current step, not generic "Careers" banner. Reads progress-bar's `aria-current="step"` and matches known step names.
5. **`21e812d`** — A2 step 2: auto-upload resume on any wizard page with a file input. Walker calls `page.setInputFiles()` with Kiran's master `.docx`. Workday's resume parser auto-fills Work Experience + Education sections.
6. **`da4c1d5`** — A2 wire-up: `--really-submit` reaches wizard Submit click + 10x queue runner. `dryRunSubmit` was hardcoded `true` regardless of flag — fixed to follow `args.reallySubmit`.
7. **`4ffe11e`** — A2: `looksLikeConfirmation` recognizes Workday's `/jobTasks/completed/application` URL. Workday's post-submit page says "Welcome, &lt;name&gt;" not "thank you", so the existing regex missed it.
8. **`15f03d8`** — A2: post-hoc summary scraper with balanced-brace JSON parser. The inline queue parser used a lazy regex that grabbed the first nested `}`, mis-classifying every successful run as "error".
9. **`ed70689`** — A2: sign-in recovery for tenants that drop session post-createAccount. `signInIfNeeded` runs at the start of `runWalkWizard`: detects Create Account / login form, clicks Sign In tab if available, fills the registered email + password, navigates back to apply URL. Unblocked UBC + both QuadReal jobs.
10. **`93f5bc2` + `1287bcd`** — A2: signInIfNeeded diagnostics — always log decision; surface probe errors instead of silently swallowing.
11. **`<later>`** — A2: signInIfNeeded shims `__name` inside `page.evaluate`. tsx/esbuild wraps inner named functions with `__name(fn, "name")` for stack traces, but the page context doesn't have `__name` defined, so the probe was silently throwing. Same shim pattern the introspector already uses.
12. **`4606842`** — A2: hardened LLM-response handling. formAgent now extracts the first balanced `{...}` from prose-wrapped responses. walkWizard wraps `planFormFill` in try/catch so a single bad LLM response only kills that attempt — retry loop tries again.

### Architecture summary

- **`steps/createAccount.ts`** — A1.4: deterministic password, Workday account creation, ~17s avg
- **`steps/waitForOtp.ts`** + **`enterOtp.ts`** — A1.5+A1.6: Gmail polling + OTP/verification-link entry
- **`steps/walkWizard.ts`** — A2 orchestrator: introspect → plan (Claude Sonnet 4.6) → apply → advance, max 2 retries per step. Auto-uploads resume on any step with a file input.
- **`steps/formIntrospector.ts`** — Captures every interactive element on the page as structured fields + raw widgets. Handles native radios, role-based radios, listbox-buttons, multi-select pills, and 7 Workday widget patterns.
- **`steps/formAgent.ts`** — Sends formState + candidate profile + JD to Claude. System prompt forbids fabrication, requires interview-optimization tone, returns strict JSON action list.
- **`steps/formActuator.ts`** — Executes the LLM's plan: 6 click strategies for radios, listbox-button shortcut, cascading-menu walker for "How did you hear about us?", file uploads, etc.

### Remaining blockers (2 of 10 unsubmitted)

**FIL (Fidelity) — Save & Continue silently no-ops despite clean fill.**
4 iterations got further each time:
- v1 (original queue): stuck because session lost post-createAccount
- v2 (sign-in recovery added in `ed70689`): unsuccessful — classifier returned `auto_logged_in` but page still on Create Account
- v3 (classifier fix `c616e68` requires `verifyPassword` not visible): reached My Information; failed at Province dropdown which on FIL is country→province cascade
- v4 (cascading-fallthrough `1274af9`): all 21 actions OK including BC under Canada, errors=0 after fill, **but the page does not advance after `Save & Continue`**. Most likely a hidden `click_filter` overlay or a follow-up "Please specify" required field after the source dropdown's "Other" fallback (LinkedIn isn't in FIL's source options).

Followup needs DevTools inspection of FIL's My Information page after the form is filled to identify the silent blocker. All earlier patches are productive even without finishing FIL — they unblocked UBC + both QuadReal jobs (3 of the 4 stuck tenants on this pattern).

**Best Buy Canada — JD-page Apply button selector miss.**
`createAccount.ts:425` throws "Apply button not found on JD page" — Best Buy renders the Apply button outside the standard `[data-automation-id="adventureButton"]` selector chain. Needs Best Buy-specific selector probe (likely `[data-automation-id="apply-link"]` or a `<button>` with text "Apply Now").

### How to reproduce / re-run

```bash
cd C:\dev\autoapply-worker
# Single URL:
npx tsx scripts/smoke_full_apply.ts "<url>" kiranshahi.can@gmail.com --really-submit

# Full queue:
npx tsx scripts/run_queue_full_apply.ts

# Re-scrape an existing run dir:
npx tsx scripts/scrape_queue_summary.ts logs/queue-run-2026-05-03T10-23-31-788Z
```

Full per-URL logs in `C:\dev\autoapply-worker\logs\queue-run-2026-05-03T10-23-31-788Z\job-N-tenant.log` with formState dumps in `logs/wizard-dumps/`.
