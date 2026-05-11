# Phase 1 — Self-Serve Handoff Plan

**Goal:** A new user can click an invite link and reach "first application submitted" without anyone from the team touching their account.

**Today (state of the world):** Managed-service model only. The website does capture + tailoring + the dashboard, but the worker runs on the founder's laptop. A new user clicking the link sees a dashboard with no way to actually drive submissions.

**Target (Phase 1 done):** Sign in → onboarding wizard → upload resume → fill profile → connect Gmail → capture first job → worker (hosted) picks it up → submission within 10 minutes. No team intervention required.

---

## What ships in Phase 1

### 1. Profile completeness gate ⭐ START HERE
**What:** A badge in the navbar and a modal on `/console` that shows "Your profile is X% complete — N fields missing." Block the "Queue" button when < 90%.

**Why:** Today, an incomplete profile causes the worker to bail mid-wizard with cryptic errors ("step 1 did not advance, Country Phone Code missing"). The user has no idea their profile is the problem. The gate fails fast at the right place.

**Fields counted toward the percentage:**
- Identity: firstName, lastName, email, phone (4 fields, 5% each = 20%)
- Address: line1, city, state, country, postalCode (5 fields, 5% each = 25%)
- Work auth: authorizedToWorkInCanada OR authorizedToWorkInUS, workAuthDescription (2 fields = 10%)
- Career: currentTitle, yearsOfExperience, resume text (3 fields = 15%)
- Defaults: noticeRequired, desiredSalary (2 fields = 10%)
- Demographic: gender (or "Decline to Answer"), ethnicity — auto-defaulted to decline (0% gate, just marked)
- Master resume uploaded: yes/no (20%)

**Effort:** Small. New API route `/api/user/profile/completeness`, hook in `/console` page, badge in nav.

**Owner:** ready to build now.

---

### 2. Hosted worker (Railway)
**What:** Deploy `autoapply-worker` to Railway as a long-running service. One container per active user, autoscaled. Existing `Dockerfile` + `RAILWAY.md` are 90% of the work; just need to actually push the button.

**Why:** Removes the laptop dependency completely. Today a new user has zero way to get submissions without someone running the worker locally.

**Architecture:**
- One dispatcher process per user (or a shared dispatcher polling `console:queued_owners`)
- 2GB RAM per container (Playwright Chrome instance peaks ~800MB)
- Logs streamed to Railway's log viewer + uploaded to Vercel Blob for dashboard "stuck screenshot" display
- Env vars: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ANTHROPIC_API_KEY`, `WORKER_PASSWORD_SECRET`

**Effort:** Medium. ~1 day of work to deploy + smoke test. Mostly DevOps, not feature dev.

**Cost:** Railway Hobby tier $5/mo per active user. Acceptable if user is paying for their own LLM costs (see #4).

---

### 3. Per-user Gmail OAuth flow
**What:** Replace the local `.token.json` OAuth approach with a hosted OAuth flow on `/onboarding`. User clicks "Connect Gmail", goes through Google consent, our app stores `refresh_token` in Redis at `gmail_oauth:{email}`. Worker reads from Redis when it needs to poll for OTPs.

**Why:** New users will create a fresh Gmail account (your preference). They need a self-serve way to give us OTP-reading access without us sharing a service account.

**Scopes needed:** `https://www.googleapis.com/auth/gmail.readonly` — just read messages, no modify/send.

**Effort:** Medium. ~half-day. NextAuth already has Google provider — we extend it with the gmail.readonly scope and stash the refresh_token.

---

### 4. Bring-your-own Anthropic key OR Stripe billing
**What:** Two options, pick one for Phase 1:

**Option A — Bring your own key (faster to ship):**
- Onboarding step: "Paste your Anthropic API key"
- Stored encrypted in Redis at `anthropic_key:{email}`
- Tailor/formAgent calls use the user's key, not the global one
- Effort: small. ~half-day. Risk: users have to set up Anthropic billing themselves, which is a friction point.

**Option B — Stripe billing (more polished):**
- Stripe Connect or Checkout subscription
- Charge users a flat fee or metered ($X per submission)
- Our shared Anthropic key remains, but we now control the unit economics
- Effort: large. ~2-3 days. Risk: real money / tax / refunds.

**Recommendation:** Ship Option A for Phase 1, move to B in Phase 2 once we know what a fair price is.

---

### 5. Onboarding wizard
**What:** New `/onboarding` flow that walks a fresh user through:

| Step | What | Required |
|---|---|---|
| 1 | Sign in (Google) | ✓ |
| 2 | Upload resume | ✓ |
| 3 | Confirm parsed profile fields (address, phone, work auth) | ✓ |
| 4 | Paste Anthropic API key | ✓ |
| 5 | Connect Gmail (OAuth) | ✓ |
| 6 | Install Chrome extension (link to Chrome Web Store) | ✓ |
| 7 | Capture first job (LinkedIn pull demo OR paste a URL) | optional |
| 8 | "You're ready" — dashboard reveals | — |

User can't reach `/console` queue button until steps 1-6 are green. This is where the X% completeness gate (#1) lives.

**Effort:** Medium. ~1 day. Mostly UI work + wiring existing endpoints together.

---

### 6. Documentation linked from dashboard
**What:** A "Help & Setup" link in the navbar. Lands on `/docs/getting-started`. Sections:

1. What AutoApply does (one paragraph)
2. The 5 steps to first submission
3. Troubleshooting (worker not picking up jobs, OAuth failed, resume not parsing, etc.)
4. Privacy + data: what we store, what we don't, how to delete your account

**Effort:** Small. ~half-day. Mostly writing, not building.

---

## Out of scope for Phase 1 (Phase 2+)

- Per-user worker isolation (currently shared dispatcher will work for ~5 users; needs split when > 10)
- Multi-resume support (same user, different target roles)
- Mobile companion app (capture from phone)
- Analytics dashboard with funnel metrics
- Stripe billing (defer — bring-your-own-key is the Phase 1 answer)
- Self-serve account deletion (manual via support for now)
- Brex-style ATS that hosts forms on company SPA (acknowledged broken; not Phase 1)

---

## Effort summary

| Item | Effort | Order |
|---|---|---|
| Profile X% gate | Small (1 day) | **1st** — ship today |
| Onboarding wizard | Medium (1 day) | 2nd |
| Per-user Gmail OAuth | Medium (½ day) | 3rd |
| Bring-your-own Anthropic key | Small (½ day) | 4th |
| Hosted worker (Railway) | Medium (1 day) | 5th |
| Documentation | Small (½ day) | 6th |

**Total: ~4 working days for the full Phase 1.** Roughly 1 week elapsed if shipping serially with testing between each.

---

## Acceptance criteria — "Phase 1 complete" looks like

1. New user clicks invite link → reaches dashboard within 10 minutes
2. Onboarding wizard does not let them queue jobs with < 90% profile complete
3. Their first captured job triggers a hosted worker run within 5 minutes (no team intervention)
4. Their tailoring costs are billed to their own Anthropic account
5. They can find a "Help" link from the dashboard that answers their setup questions
6. Test it: ask one beta user (your friend, your sister, anyone) to go through it cold. They reach first submission without asking you anything.

The last criterion is the only one that matters. The other five are checkboxes.
