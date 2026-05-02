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

## Hour 0.5+ — Step 2 (dashboard) starting

Building `/dashboard/applications` (list) + `/dashboard/applications/[id]` (review). Reads from Redis under `audit:{appId}` keys. Pushes to Vercel.
