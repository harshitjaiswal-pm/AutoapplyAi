# Overnight bug-fixing run — 2026-04-30 → 2026-05-01

Summary of the seven PRs landed during the overnight run, the bugs each one
addresses, and what still needs morning verification before the 10×Workday test.

## PRs created and merged

| #   | Title                                                                                    | Status | Key files                                                                |
| --- | ---------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| 13  | PR1 — manifest sapsf.com + smartrecruiters trigger + robust panel toggle                 | merged | `chrome-extension/manifest.json`, `chrome-extension/background.js`       |
| 14  | PR2 — F1/F18 resume key fallback + BUG-002 LastName_Company_Role filename                | merged | `chrome-extension/background.js`, `src/lib/buildFilename.ts`             |
| 15  | PR3 — Workday skills chip-verify (#30) + degree fuzzy-match (#31)                        | merged | `chrome-extension/ats/workday.js`                                        |
| 16  | PR4 — Greenhouse contenteditable + work-auth combobox + start-date/edu collision         | merged | `chrome-extension/ats/greenhouse.js`                                     |
| 17  | PR5 — Phase D — extension applies worker's saved fills to live SAP form                  | merged | `chrome-extension/ats/successfactors.js`                                 |
| 18  | PR6 — separate 'Try again' (re-tailor) from 'Reload resume' (refetch PDF) (#37/#38)      | merged | `chrome-extension/ats/generic.js`                                        |
| 19  | PR7 — per-job lock prevents tab-job mapping race in batch mode (A.5)                     | merged | `chrome-extension/background.js`                                         |

All 7 PRs squash-merged into `main`. `npx tsc --noEmit` clean after each.

## Bugs from the user's list that were fixed

- **F1 / F18** — Wrong resume served / "Tailor resume" button shown when PDF
  exists. Fixed in **PR2** with three-tier lookup: ATS URL key → LinkedIn
  URL key → company+title fuzzy match.
- **BUG-002** — Recruiters seeing `AutoApply_TailoredResume.pdf`. Fixed in
  **PR2**: filename convention is now `{LastName}_{Company}_{RoleAbbr}.pdf`
  (e.g. `Jaiswal_Zynga_PM.pdf`) used in all three filename build paths.
- **#14 / #15** (the abandonment trigger) — Open-ended Greenhouse questions
  left blank. Fixed in **PR4** by detecting `[contenteditable=true]`,
  `.ql-editor` (Quill), `[role=textbox][contenteditable]`, and
  `[role=textbox]:not(input):not(textarea)` (Slate / Trix). Uses
  `element.ownerDocument.execCommand` for cross-frame safety.
- **GH-2** — Work-authorization Y/N collapsed dropdown stayed unanswered.
  Fixed in **PR4**: trigger detection now includes `button[role=combobox]`,
  `button[aria-haspopup=listbox]`, and `button[aria-expanded]`.
- **GH-1** — "2 weeks notice" bleeding into Education start-date fields.
  Fixed in **PR4**: `fillByLabel` now accepts `opts.avoidSections` and
  rejects candidates inside an Education section ancestor.
- **#30** — Workday skills loop. Fixed in **PR3**: chip-counter verification
  before/after each fill.
- **#31** — Workday Education degree "Select One" stays unselected. Fixed
  in **PR3** with `selectDegreeDropdownFuzzy` fallback that scores options
  on stem-match ("Bachelor's Degree", "Bachelor of Engineering", raw-string
  contains).
- **#37 / #38** — Try Again vs Reload Resume conflated. Fixed in **PR6**.
- **A.5** — Tab-job mapping race in batch mode. Fixed in **PR7** with the
  per-job `claimedJobs` Map keyed on `_queuedAt`.
- **TELUS Workday (sapsf.com) panel never appeared** — Fixed in **PR1**:
  manifest match for `*.sapsf.com`, `KNOWN_ATS_DOMAINS` updated,
  panel toggle uses `setProperty(...,'important')` to win specificity.
- **SmartRecruiters never activated** — Fixed in **PR1** by adding
  `smartrecruiters.com` to `KNOWN_ATS_DOMAINS`.
- **Phase D not wired** — Fixed in **PR5**: `successfactors.js` now reads
  `/api/pending-fill`, applies fields, shows green overlay.

## Bugs that need live ATS testing tomorrow

These were fixed at the code-level but NEED morning verification because
they can only be confirmed against a live ATS:

1. **PR1 panel toggle on TELUS** — code change should resolve, but verify
   on `https://careers.telus.com/job/Vancouver-Strategy-Specialist...` that
   the panel actually slides in and the console shows `[AutoApply] panel opened`.
2. **PR2 LastName filename in extension flow** — verify Downloads folder
   shows `Jaiswal_<Company>_<RoleAbbr>.pdf` after a real LinkedIn batch
   tailor (not the old `AutoApply_TailoredResume.pdf`).
3. **PR3 Workday skills chip count** — Workday DOM varies by tenant; the
   chip selector list (`[data-automation-id*="selectedItem" i]`,
   `[data-automation-id^="DELETE_"]`, `[role=button][aria-label*=remove i]`)
   is best-effort. If chips don't register, expand the selector list.
4. **PR3 degree fuzzy match** — works for "Bachelor's Degree" and "Bachelor
   of Engineering" by design. If a Workday tenant uses entirely different
   option text (e.g. "Diploma in Engineering" without "Bachelor"), the
   match may fall through to no-op. Worth a manual test.
5. **PR4 Greenhouse contenteditable / Quill** — verify the open-ended
   answer actually lands in a Quill editor. Quill's commit semantics vary
   by version; the InputEvent + change + blur sequence should cover most
   versions but is unverified live.
6. **PR4 work-auth combobox** — confirm a Greenhouse work-auth question
   that uses `<button>` (not React-Select div) gets answered.
7. **PR4 start-date/education collision** — confirm "earliest start"
   answer no longer leaks into Education's "Start date month" field. If
   the Education section uses a non-standard heading, may need to expand
   `avoidSections`.
8. **PR5 Phase D end-to-end** — needs `_aa_userId` and `_aa_workerToken`
   set in `chrome.storage.local`, plus a real worker run that wrote to
   Redis. Verify the green overlay appears and fields are filled.
9. **PR6 Reload Resume** — verify the cached PDF actually downloads
   without an LLM call. Watch the network tab — should NOT see
   `/api/tailor-resume` traffic.
10. **PR7 batch race** — fire 3+ batch jobs from LinkedIn rapidly and
    confirm each ATS tab claims a distinct `pendingApplication` (look
    for `bg.inject.skipDuplicateClaim` log entries on the late-firing
    duplicate, and confirm no two tabs got the same job).

## Bugs that need more investigation than tonight allowed

- **#28 / #32 — Workday Work Experience From-date and Role Description left
  blank.** The existing `fillDateFieldInBlock` + `fillSpinbuttonDateInBlock`
  +  textarea/contenteditable role-description path already implements
  React-aware setters and the BUG-009 / BUG-010 fixes are recent. Without
  a reproducible Workday URL where this is observed, I can't tell whether
  the failure is field detection (label scan misses) or a different React
  commit gate. **Defer to live testing tomorrow** — if it still reproduces
  on Salvation Army / TELUS Workday, capture the DOM of the empty fields
  (right-click → Inspect → copy outerHTML) and we can target the missing
  selector / commit path next session.

## Suggested test sequence for the morning's 10×Workday run

1. **Sanity check (5 min):** load the rebuilt extension, open
   chrome://extensions, click "Reload" on AutoApply. Set
   `chrome.storage.local.set({ _aa_userId: 'harshit.schulich@gmail.com', _aa_workerToken: '<from worker .env>' })`
   in DevTools console for the SAP page.
2. **Single-job dry run on TELUS sapsf.com (10 min):** Navigate to a TELUS
   `career17.sapsf.com` application form → expect the green overlay
   "Filled by AutoApply" to appear within ~3s. Verify (a) panel opens
   when clicking the floating pill, (b) overlay shows correct field count.
3. **Greenhouse spot test (10 min):** Pick one Greenhouse posting from the
   reference list with: open-ended Quill questions + work-auth combobox +
   Education section. Confirm all three previously-broken paths now work.
4. **Workday spot test (15 min):** Pick a Workday posting (Salvation Army
   or any wd1.myworkdayjobs.com) with skills + education sections. Confirm
   skills chips render and degree dropdown gets selected. If From-date /
   Role Description still blank, capture the DOM and we'll fix tomorrow
   night.
5. **Filename check (2 min):** download a tailored resume from any of the
   above → confirm filename in Downloads is `Jaiswal_<Company>_<RoleAbbr>.pdf`.
6. **The 10× batch (30-45 min):** kick off the actual 10-job Workday batch.
   Watch the console for `bg.inject.skipDuplicateClaim` — these are EXPECTED
   on duplicate tab updates and prove the per-job lock is working.
7. **Reload Resume button check (1 min):** in the panel after a successful
   tailor, click "Reload resume" — should be instant, no `/api/tailor-resume`
   network call.

If anything reproduces from the "needs live testing" list, the next
session can target the specific failure with DOM evidence rather than
guessing at which selector / commit pattern matters.
