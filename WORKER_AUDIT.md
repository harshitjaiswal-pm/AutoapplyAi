# Worker Audit — autoapply-worker

**Audit date:** 2026-05-01 17:35 PT  
**Auditor:** Claude (autonomous loop, hour 0)  
**Repo:** `C:\dev\autoapply-worker` (cloned from `harshitjaiswal-pm/autoapply-worker`)

## TL;DR

The worker has solid **scaffolding** (BullMQ queue, step pipeline, audit log, suspend signal for OTP, Cloudflare R2 storage, cost tracking). What's actually **implemented** for end-to-end application flow is far less than the architecture suggests. There is one TELUS-specific monolithic apply flow in `steps/runApplication.ts` (1595 lines), but it stops at "pre-submit screenshot" — no real submit, no Workday-specific adapter, no screener Q&A wiring, no resume upload to live form.

**Honest scope estimate to get Workday anon-apply genuinely end-to-end on one tenant:** 2–3 focused days. The 18-hour autonomous loop will produce a *partial demo* — likely tailor + open + dashboard render + step trace, with the live form fill stubbed or partially working on UBC only.

## File-by-file inventory

| File | LoC | What it actually does |
|---|---|---|
| `server.ts` | 222 | HTTP server (`/health`, `/smoke`, `/audit/{id}`), boots BullMQ workers, exposes `enqueueRunApplication` |
| `runner.ts` | 93 | BullMQ worker process — pulls steps off `worker-steps` queue, dispatches to `STEP_HANDLERS` registry, supports suspend/retry/next-step |
| `queue.ts` | 316 | BullMQ wrapper — `enqueueTailorResume`, `enqueueOpenAts`, `enqueueRunApplication`, ID generation, ioredis connection |
| `steps/index.ts` | 52 | Step registry. **Only `tailor_resume` is wired up.** All other handlers (open_ats, fill_form, upload_resume, answer_question, submit, create_account, wait_for_otp, enter_otp) are commented out. |
| `steps/tailorResume.ts` | 69 | Calls `${AUTOAPPLY_API_BASE}/api/tailor-resume` on the Vercel app, uploads result to R2 as JSON. Cost-tracked. **Works.** |
| `steps/openAts.ts` | 77 | Loads job URL in Playwright, screenshots, uploads to R2, counts Apply buttons. **Doesn't click.** |
| `steps/runApplication.ts` | 1595 | Monolithic apply flow. TELUS-specific (SAP req ID extraction, post_login_nav). Steps: tailor → open → start_application (click Apply) → detect_form_fields → fill_form (name/email/phone) → pre_submit_screenshot. **Always DRY_RUN — no submit.** |
| `audit.ts` | 116 | Append-only step log to Redis under `audit:{applicationId}` |
| `r2.ts` | 46 | Cloudflare R2 client wrapper |
| `upstashRedis.ts` | 139 | Reads user resume from `user:{email}:resume`. Has `getUserResume(email)` helper. |
| `schemas.ts` | 433 | Zod schemas (audit step types, etc.) |
| `fixtures.ts` | 101 | **Stale Kiran resume fixture** (Bangalore, "Aug 2025" The Brick, missing companies) + TELUS_TEST_JOB |
| `smoke-tests.ts` | 160 | Self-tests for Redis, R2, fixtures, API base |

## What works today (verified by reading)

1. **Tailor resume via API.** `runTailorResume` works against the Vercel `/api/tailor-resume` endpoint. Cost tracking accurate.
2. **Open ATS + screenshot.** Playwright launches, navigates, screenshots, uploads to R2.
3. **Audit log.** Each step writes a structured `AuditStep` to Redis. Already what we want for dashboard trace.
4. **TELUS SAP flow** in `runApplication.ts` clicks Apply and detects form fields. Specific to SuccessFactors, not Workday.
5. **DRY_RUN mode.** Default — no actual submit ever happens.

## What's stubbed or missing (the gaps)

### Critical gaps for Workday end-to-end

1. **No Workday-specific Apply-click logic.** The selectors in `runApplication.ts` are generic but Workday wraps the Apply button in a complex SPA shell. Per the existing chrome-extension `ats/workday.js`, clicking Apply on Workday requires:
   - Wait for SPA hydration (5–10s; current `waitForTimeout(2500)` is short)
   - Click button with `[data-automation-id*="adventureButton"]` or `[data-uxi-element-id*="apply" i]`
   - Handle the "Sign In or Create Account" interstitial
   - Pick "Apply Without Signing In" if anon-apply available
2. **No multi-page wizard navigation.** Workday's apply flow is 3–6 pages (My Information → My Experience → Voluntary Disclosure → Self-Identification → Review → Submit). Current code only screenshots page 1.
3. **No resume upload.** The runApplication flow tailors a resume but never uploads it to Workday's file input. The tailored output sits in R2 as JSON.
4. **No DOCX rendering.** Tailor returns JSON; Workday wants a `.docx` or `.pdf`. The Vercel app has `/api/export-resume` for this — worker doesn't call it.
5. **No screener Q&A.** The Vercel app has `/api/answer-screener` (per overnight PR catalog) but the worker doesn't invoke it for in-form questions like "Years of SQL?"
6. **No EEO / voluntary self-ID handling.** Workday wizards always have these. Need defaulting logic.
7. **No Workday cookies / session handling.** Each apply run launches a fresh browser — fine for anon-apply, fails the moment we need accounts.
8. **No real submit.** Always stops at `pre_submit_screenshot`. The dashboard's "Approve & Submit" button has nothing to call yet.
9. **Step pipeline is unused for the apply flow.** `runApplication.ts` is monolithic; doesn't enqueue separate steps. So per-step retry / suspend doesn't work for sub-steps.

### Critical gaps for dashboard

10. **No dashboard pages exist.** `src/app/dashboard/` exists with `page.tsx` (a top-level dashboard) and `summary/route.ts`, but no `/applications` list or `/applications/[id]` detail.
11. **Audit log isn't surfaced to UI.** It writes to Redis but nothing reads it for display.
12. **No screenshot rendering path.** R2 URLs are `r2://bucket/key` form — not directly browser-renderable. Need either signed URLs or a proxy endpoint.
13. **No Approve/Submit button anywhere.**

### Critical gaps for credentials/auth (per today's decisions: deferred)

14. **No account creation flow.**
15. **No Gmail integration / OTP polling.**
16. **No credential storage.**

### Data quality issues

17. **`fixtures.ts` KIRAN_RESUME is stale.** Wrong companies (Bangalore for Fractal — should be Canada Remote per Harshit's correction), wrong dates, missing details. Worker reads from `upstashRedis.ts → getUserResume(email)` for production runs, but the fallback to fixtures is dangerous. **I'll bypass fixtures entirely for the loop** and always pull from Redis.
18. **`parsedResumeSummary` empty in Redis.** Kiran's stored resume has 6366 chars of `resumeText` but `name=''`, `jobCount=0`, `skillCount=0`. The /onboarding flow saved the raw text but didn't extract structure. Worker will need to parse `resumeText` itself or call `/api/parse-resume` on it.

### Environment / deploy gaps

19. **`AUTOAPPLY_API_BASE` defaults to `http://localhost:3000`.** Worker on Railway needs this set to `https://autoapply-ai-delta.vercel.app`.
20. **R2 creds.** Need `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_ACCOUNT_ID`. Need to confirm these are set on Railway and accessible locally.
21. **Worker Redis URL.** BullMQ uses ioredis (TCP), not Upstash REST. Need `REDIS_URL` env var pointing to a TCP-accessible Redis. Upstash exposes both — need to check.

## Realistic 18-hour scope (revised)

Given the gap analysis, the original plan ("end-to-end across 10 Workday URLs with submit-on-approve") is not achievable. Revised target:

### Achievable in 18 hours autonomous

- **Tailor resume from Redis (real Kiran data, not fixture).** Bypass `fixtures.ts`, call `getUserResume`, optionally call `/api/parse-resume` to populate the missing summary fields.
- **DOCX export wired in.** Worker calls `/api/export-resume` after tailoring, gets a `.docx` buffer, uploads to R2. (5/hour)
- **Workday-specific open + click Apply (anon-apply tenants only).** Adapt the existing chrome-extension `ats/workday.js` logic for Playwright.
- **Multi-page wizard walk for one tenant (UBC).** Page 1 fields filled, screenshots per page, audit log of every action.
- **Dashboard list page** at `/dashboard/applications`. Reads `audit:*` keys from Redis, shows status. (2/hour)
- **Dashboard detail page** at `/dashboard/applications/[id]`. Renders the audit step log, screenshot proxy, tailored resume preview. Approve&Submit button is **stubbed** (sets a flag in Redis only).
- **Screenshot proxy endpoint** at `/api/screenshot/[appId]/[step].png` so R2 images render.
- **Run the queue against the 10 reviewed Workday URLs.** Capture results.
- **Fix loop** on the most impactful failures.
- **Morning review doc.**

### NOT achievable in 18 hours (deferred to v2)

- Real submit click
- Account creation + Gmail OTP
- All 10 URLs working — realistically 3-5 will go end-to-end on first run
- Screener Q&A in-form (will be flagged as "human required" on dashboard)
- EEO/voluntary disclosure (defaulted to "Decline to Answer" or skipped)
- All 3 ATSes (Workday only — Greenhouse and Ashby explicitly deprioritized this round)
- Hybrid handoff to user browser (we said dashboard-submit; that's stubbed)

## Decision log

- **D1: Bypass fixtures.ts entirely.** Always fetch from Redis. Fixture path is too dangerous (silent drift).
- **D2: Use Vercel app for DOCX rendering** via `/api/export-resume` rather than building DOCX in worker.
- **D3: Screenshot proxy via Vercel `/api/screenshot/[appId]/[step].png`** — fetches from R2 server-side, returns inline. Avoids exposing R2 keys to browser.
- **D4: Anon-apply only in v1.** UBC, Canadian Tire, Langara, Best Buy Canada — likely have anon-apply. RBC, TD almost certainly need accounts → mark as "human required" upfront.
- **D5: Step trace = audit log already exists.** Just expose it in dashboard. Don't reinvent.
- **D6: Parallel work** — start dashboard build (Vercel side) simultaneously with worker fixes. They don't depend on each other until integration.

## Open questions for Harshit (not blocking — proceeding with conservative defaults)

- R2 creds availability locally? If not, will fall back to writing screenshots to `public/traces/{appId}/` on the Vercel filesystem (works in dev, ephemeral on Vercel — need to swap to blob storage for prod).
- BullMQ Redis (TCP) URL? If unavailable locally, will run worker against deployed Railway worker only (slower iteration).
- Acceptable to read `resumeText` raw and parse with prompts in tailoring vs requiring `/api/parse-resume` round-trip? **Defaulting: parse-on-the-fly inside tailor prompt. Cheaper, fewer hops.**

---

*Next: build the dashboard list page (parallel-safe; doesn't depend on worker fixes) and write the screenshot proxy. Then return to worker for Workday-specific click logic.*
