# Morning checklist — read this first

These two env-var setup steps are required for last night's worker
+ extension changes to actually work end-to-end. Both are 5-minute
tasks.

---

## 1. Add Upstash Redis env vars to Railway *(REQUIRED)*

Without these, the worker can't read Kiran's master resume that
you uploaded via /onboarding. Every `/run-application` call without
an explicit `parsedResume` body will fail with `resume_lookup_failed`.

**Steps:**

1. Open Vercel dashboard → https://vercel.com/dashboard
2. Click the **AutoapplyAi** project
3. Settings → Environment Variables
4. Find `UPSTASH_REDIS_REST_URL`. Click the eye icon. Copy the value.
5. Find `UPSTASH_REDIS_REST_TOKEN`. Copy the value.
6. Open Railway dashboard → https://railway.app/dashboard
7. Click the **autoapply-worker** service
8. Click the **Variables** tab
9. Click **+ New Variable**:
   - Name: `UPSTASH_REDIS_REST_URL`
   - Value: paste from step 4
10. Click **+ New Variable** again:
    - Name: `UPSTASH_REDIS_REST_TOKEN`
    - Value: paste from step 5
11. Railway will auto-redeploy the worker (~30-60s).

**Verify it worked:** trigger a worker run with no `parsedResume` body —
audit step `tailor_resume` should now use Kiran's actual master resume
(richer bullets, "Client Champion Award" etc.) instead of the fixture.

---

## 2. Set WORKER_SHARED_SECRET *(OPTIONAL — needed for Phase D extension fill + auth lockdown PR)*

This is the shared password between worker, Vercel API, and the
Chrome extension. Without it set:
- Phase D (extension auto-fills SAP form from worker's saved answers) won't work — extension calls to `/api/pending-fill` will 401
- Auth lockdown PR (#5 on AutoapplyAi, currently deferred) can't be merged

**Steps:**

1. Generate a 32-char random secret. In PowerShell:
   ```powershell
   -join ((48..57) + (97..122) + (65..90) | Get-Random -Count 32 | ForEach-Object {[char]$_})
   ```
   Copy the output — that's your secret. Don't use my example.

2. On Vercel: AutoapplyAi project → Settings → Environment Variables →
   add `WORKER_SHARED_SECRET` = (the secret you generated)

3. On Railway: autoapply-worker → Variables → add `WORKER_SHARED_SECRET` = (same secret)

4. In your Chrome (with the AutoApply extension installed):
   - Open any tab → right-click → Inspect → Console
   - Paste:
     ```js
     chrome.storage.local.set({
       _aa_workerToken: 'PASTE_THE_SECRET_HERE',
       _aa_userId: 'kiranshahi.can@gmail.com'
     });
     ```
   - Hit Enter. You should see `undefined` returned (success).

5. Verify by reloading the extension and visiting any TELUS SAP form URL.
   The extension should now fill the form from the worker's saved
   answers (Phase D from PR #17 last night).

**After this is set, we can also merge the auth lockdown PR** that's
been deferred. It locks the unauthenticated /api/* routes that anyone
on the internet can currently hit.

---

## 3. Then: 10 × Workday job test

Per last night's plan. The worker pipeline + extension are now ready
to be exercised against real Workday URLs. See `OVERNIGHT_RUN_SUMMARY.md`
for the morning verification checklist (panel slide-in, filename, etc.)
and what was deferred (Workday Work Experience From-date — needs live
DOM evidence).
