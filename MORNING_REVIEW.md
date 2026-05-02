# Morning Review — Autonomous Loop, 2026-05-01 → 2026-05-02

**Loop ran:** ~2 hours of focused work across 2 iterations.  
**Steps complete:** 4 of 5 (1, 2, 4, 5). Step 3 blocked. No wasted time spent on Step 3 — the blocker was identified in Step 1 within the first 15 minutes.

## Quickest summary

| Step | Status | What changed | Where to look |
|---|---|---|---|
| 1. Probe 10 Workday URLs | ✅ Done | All 10 reach Create Account wall — **zero anon-apply tenants** | [WORKDAY_FEASIBILITY.md](WORKDAY_FEASIBILITY.md) |
| 2. Dashboard pages + API | ✅ Done | `/dashboard/applications` (list) + `/dashboard/applications/[id]` (review) | branch `harshit/loop-step2-dashboard` |
| 3. Workday Playwright adapter | ⚠️ Blocked | No anon-apply tenants → can't test what Step 1 said wasn't there | n/a |
| 4. DOCX export in worker tailor flow | ✅ Done | `tailorResume.ts` now POSTs to `/api/export-resume`, uploads .docx to R2 | branch `harshit/step4-docx-export` on `autoapply-worker` |
| 5. Parse Kiran's resumeText | ✅ Done | `name='Kiran Shahi', jobCount=5, skillCount=52` now in Redis | `scripts/parse_kiran_resume.py` |

## The one big strategic finding

**You cannot end-to-end-apply to any of your 10 reviewed Workday URLs without account creation.** The "anon-apply Workday tenants only" decision we made yesterday is not viable on this queue — period. Every tenant (UBC, Canadian Tire ×3, Langara, QuadReal ×2, Fidelity, Fednav, Best Buy) routes through "Create Account / Sign In" as Step 1 of the wizard.

This means **before any further Workday work**, you have to choose:

### Option A — Build Workday account creation (~6–10 hours added scope)
- Worker generates a strong password per tenant (or reuses one — security trade-off)
- Worker fills Create Account form, submits
- Worker polls Gmail for verification email or OTP — Gmail App Password + IMAP is the 5-minute setup; full OAuth is multi-hour
- Worker stores `(tenant, email, password)` encrypted in Upstash
- This is essentially a small product on its own. Doable, but it's the **biggest single piece of work between us and a Workday demo**.

### Option B — Pivot to Greenhouse / Ashby for v1 (recommended)
- Greenhouse is anon-apply by default. Lever same. Ashby same.
- Shippable end-to-end demo in 1–2 days, not 5–7.
- Defer Workday account creation to v2 — by which point we have a working v1 and a clearer sense of what the wizard walker actually needs to do.
- Lose Workday coverage for now; cover ~30% of postings at first instead of ~50%.

### Option C — Hybrid
- Greenhouse end-to-end now (Option B path).
- Workday account creation as a parallel v2 work stream, picked up after Kiran has used Greenhouse for a week and fed back what's annoying about reviewing applications.

**My recommendation: Option C.** Maximizes your shipped surface area with the time you have. If you push hard on Workday-only you might still not have a working demo by next weekend.

## What you can demo today

Pull `harshit/loop-step2-dashboard`, run `npm run dev`, sign in as Harshit. The mock data path:

1. Visit **`/dashboard/applications`** → see 3 mock applications (UBC completed, Canadian Tire in-progress, Langara failed at Create Account wall).
2. Click any → full review page renders:
   - Job header + status badge + cost + duration
   - Tailored resume placeholder (DOCX preview pending the R2 proxy — Step 4 wired up the worker side, the dashboard preview just shows the artifact URL today)
   - Q&A table (mock-001 has 5 questions including one human-flagged with amber chip)
   - Step trace (6 steps for mock-001 with inline screenshots from `placehold.co`, error highlighting on mock-003)
   - Big green **Approve & Submit (stubbed)** button — clicks set `status=submitted_stubbed` in Redis, no actual submit happens
3. The mock-003 failure message reads:
   > "After clicking Apply Manually, landed on Create Account form. Account creation flow not implemented in v1 (anon-apply tenant required). See WORKDAY_FEASIBILITY.md."

   That's the same finding Step 1 surfaced — encoded in a fixture so the dashboard story end-to-end is consistent.

## Concrete artifacts in this branch

- `WORKER_AUDIT.md` — gap analysis of the autoapply-worker repo. Worth a 10-min read before deciding scope; the worker is more skeleton than its scaffolding suggests.
- `WORKDAY_FEASIBILITY.md` — the full per-URL probe results with screenshots. The data behind the strategic finding above.
- `LOOP_PROGRESS.md` — the running log of each loop iteration. Useful if you want to see what Claude did when.
- `src/app/api/applications/route.ts` + `[id]/route.ts` — list + detail + approve API.
- `src/app/dashboard/applications/page.tsx` + `[id]/page.tsx` — the new pages.
- `scripts/seed_mock_audits.py` — re-runnable mock seeder. If Redis loses the mock data, just `python scripts/seed_mock_audits.py`.
- `scripts/parse_kiran_resume.py` — the resume parser. Re-runnable; idempotent.

## Concrete artifacts on `autoapply-worker` branch `harshit/step4-docx-export`

- `steps/tailorResume.ts` — DOCX export wired in.
- `steps/runApplication.ts` — audit step output extended.
- `.gitignore` — new (the repo didn't have one).

## Pre-existing issues I noticed but didn't fix

1. **GitHub PAT in plaintext** in `.git/config` of autoapply-ai — already flagged in chat. Rotate when you read this.
2. **Worker has TS errors** that don't block runtime (tsx doesn't typecheck) — `runner.ts` queue exports + DOM types in `page.evaluate` blocks of `runApplication.ts`. Worth a cleanup PR but not blocking.
3. **`fixtures.ts` KIRAN_RESUME is stale** in the worker (Bangalore for Fractal, missing companies). Worker reads from Redis for production — fixture is only for sitting-1 e2e tests — but anyone running smoke tests gets the wrong data. Either delete the fixture or refresh from Redis.
4. **`/api/tailor-resume` and `/api/export-resume` are unauthenticated.** Anyone on the internet can hit them and burn your Anthropic budget. The auth-lockdown PR has been deferred for this morning's testing — get it merged.
5. **`parsedResumeSummary` in /onboarding** doesn't compute the structured summary on initial save. Step 5's script fixed Kiran's record one-time, but new uploads will still arrive with empty summary. Fix either in the /onboarding flow or in `/api/user/resume:POST` to call `/api/parse-resume` synchronously before write.

## What I'd do next session if you said "continue"

In order of value:

1. **Make the call between A/B/C above.** That choice gates everything.
2. If **Option B/C** — clone the Workday adapter scaffolding for Greenhouse: it's much simpler (single page, anon-apply, file upload + textarea + Submit). 1 day to working demo.
3. **R2 proxy endpoint** at `/api/r2/[...key]` — needed so dashboard's resume preview iframe actually shows the .docx instead of just listing the URL. ~30 min if R2 creds are exposed in Vercel env, ~2 hr if not.
4. **Auth-lockdown PR for /api/* routes** — overdue, blocking real production rollout.
5. **Account creation worker step** if you go Option A or v2.
6. **Real Q&A wiring** — when the worker walks the wizard, capture each label/value pair and surface in the dashboard's Q&A table. Currently the mock has 5 hardcoded; real flow needs to populate dynamically.

## Honest reflection on the loop

- **Best decision tonight:** spending 15 minutes probing the URLs first instead of starting on the Playwright adapter. Found out anon-apply doesn't exist before burning hours on the wrong abstraction.
- **Wasted time:** ~5 minutes on a buggy Upstash REST shape (`POST /set/...` vs JSON command body) and a Windows-encoding print error. Recoverable.
- **What I should have asked you up front but didn't:** "do you want me to also do account creation if anon-apply turns out to be missing on most tenants?" — that single question would have saved the Step 3 pivot.
- **What I'd want clarity on:** account credentials storage — Upstash plaintext is unacceptable for prod; need a real call (1Password CLI? Vercel env per tenant? secrets manager?).

## Reviewing checklist for you when you read this

- [ ] Read [WORKDAY_FEASIBILITY.md](WORKDAY_FEASIBILITY.md), confirm the finding
- [ ] Decide A / B / C (see above)
- [ ] Pull `harshit/loop-step2-dashboard`, run dev server, click around the dashboard pages, decide if the layout/UX direction is right
- [ ] Open the autoapply-worker `harshit/step4-docx-export` PR, review the 90-line tailorResume diff
- [ ] Reply with one of: "merge step 2", "merge step 4", "do greenhouse next", "build account creation"
- [ ] Rotate the GitHub PAT in `.git/config`

— Good morning.
