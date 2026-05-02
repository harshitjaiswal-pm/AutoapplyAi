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
