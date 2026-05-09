"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { SubmissionRecord, SubmissionOutcome } from "@/lib/submissions";
import { deriveOutcome, FAILURE_GUIDANCE } from "@/lib/submissions";
import type { TenantCredsRow } from "../../api/credentials/route";
import { CopyButton } from "@/components/CopyButton";
import { TailoredResumeView } from "@/components/TailoredResumeView";
import CostBreakdown from "@/components/CostBreakdown";
import ApprovalButtons from "@/components/ApprovalButtons";

const OUTCOME_STYLES: Record<SubmissionOutcome, string> = {
  running: "bg-blue-100 text-blue-700",
  awaiting_review: "bg-amber-100 text-amber-800",
  submitted: "bg-emerald-100 text-emerald-700",
  already_applied: "bg-teal-100 text-teal-700",
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
};

const OUTCOME_LABEL: Record<SubmissionOutcome, string> = {
  running: "Running",
  awaiting_review: "Awaiting Review",
  submitted: "Submitted",
  already_applied: "Already Applied",
  partial: "Partial",
  failed: "Failed",
};

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export default function SubmissionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [submission, setSubmission] = useState<SubmissionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomedShot, setZoomedShot] = useState<string | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [tenantCreds, setTenantCreds] = useState<TenantCredsRow | null>(null);
  const [revealPassword, setRevealPassword] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/applications/${id}`);
        if (!res.ok) {
          setError(res.status === 404 ? "Submission not found." : `Failed to load: ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setSubmission(data.submission);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 8_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  // Fetch this user's tenant_creds and find the row that matches this
  // submission's tenant — so we can show username + password used to
  // create the Workday account on this very page.
  useEffect(() => {
    if (!submission?.tenant) return;
    let cancelled = false;
    fetch("/api/credentials")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const creds: TenantCredsRow[] = data.credentials ?? [];
        const match = creds.find((c) => c.tenantHost === submission.tenant);
        setTenantCreds(match ?? null);
      })
      .catch(() => { /* tolerate */ });
    return () => {
      cancelled = true;
    };
  }, [submission?.tenant]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link href="/applications" className="text-xs text-indigo-600 hover:text-indigo-700">← All submissions</Link>
        <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">{error}</div>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-center text-neutral-400 text-sm">Loading…</div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <Link href="/applications" className="text-xs text-indigo-300 hover:text-white">← All submissions</Link>
          <div className="flex items-start justify-between gap-4 mt-2">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold truncate">{submission.jobTitle}</h1>
              <p className="text-indigo-300 text-sm mt-1">
                {submission.company}
                {submission.tenant && <> · <span className="text-indigo-400">{submission.tenant}</span></>}
              </p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-2">
              <span
                className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${OUTCOME_STYLES[deriveOutcome(submission)]}`}
                title={
                  deriveOutcome(submission) === "partial"
                    ? (submission.stoppedReason ?? "Wizard advanced but did not reach the confirmation page")
                    : undefined
                }
              >
                {OUTCOME_LABEL[deriveOutcome(submission)]}
              </span>
              {submission.matchScore != null && (
                <div className="text-right">
                  <span className={`text-2xl font-bold tabular-nums ${
                    submission.matchScore >= 80 ? "text-emerald-300" :
                    submission.matchScore >= 60 ? "text-amber-300" : "text-indigo-200"
                  }`}>
                    {submission.matchScore}
                  </span>
                  <span className="text-xs text-indigo-300 ml-1">/100 match</span>
                  {submission.originalMatchScore != null && submission.matchScore > submission.originalMatchScore && (
                    <p className="text-[10px] text-emerald-300 mt-0.5">
                      +{submission.matchScore - submission.originalMatchScore} from {submission.originalMatchScore} after tailoring
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Live activity badge — pulsing indigo while the worker is
              actively running. Auto-clears when the worker calls
              recordSubmissionFinish (status moves to completed/failed).
              Visibility into what the headless dispatcher is doing
              right now without tailing Railway logs. */}
          {submission.status === "in_progress" && submission.currentActivity && (
            <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/20 border border-blue-400/40">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-300 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400"></span>
              </span>
              <span className="text-xs text-blue-100 font-medium">
                {submission.currentActivity}
              </span>
            </div>
          )}

          {/* Pinned-to-hero review CTA — when the worker is paused for
              human approval, the buttons must be visible immediately
              without scrolling. Same component used below the hero for
              the post-approval read-only banner is repurposed here so
              there's only one source of truth. */}
          {id && submission.reviewStatus === "awaiting_review" && (
            <div className="mt-6">
              <ApprovalButtons
                applicationId={id}
                onChange={async () => {
                  try {
                    const res = await fetch(`/api/applications/${id}`);
                    if (res.ok) {
                      const data = await res.json();
                      setSubmission(data.submission);
                    }
                  } catch { /* tolerate */ }
                }}
              />
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 text-xs">
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Started</p>
              <p className="mt-0.5">{fmtDate(submission.startedAt)}</p>
              <p className="text-indigo-300">{fmtTime(submission.startedAt)}</p>
            </div>
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Finished</p>
              <p className="mt-0.5">{submission.completedAt ? fmtDate(submission.completedAt) : "—"}</p>
              <p className="text-indigo-300">{fmtTime(submission.completedAt)}</p>
            </div>
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Source</p>
              <p className="mt-0.5">{submission.source}</p>
            </div>
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Job URL</p>
              <a href={submission.jobUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-200 hover:text-white text-[10px] underline block truncate">
                Open ↗
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Note: Approve/Reject CTA lives INSIDE the hero above so it's
            always above the fold. Below this point we only render the
            terminal-state banners (approved/rejected). */}

        {/* Read-only banner for terminal review states (approved means
            phase 2 is in flight; rejected means terminal). */}
        {submission.reviewStatus === "approved" && submission.status === "in_progress" && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-800">
            Approved at {fmtTime(submission.reviewStatusAt)} — worker is now walking the wizard and will click Submit. Watch the live activity badge above.
          </div>
        )}
        {submission.reviewStatus === "rejected" && (
          <div className="bg-neutral-100 border border-neutral-300 rounded-xl p-3 text-xs text-neutral-700">
            Rejected at {fmtTime(submission.reviewStatusAt)} — nothing was sent to the company. Use Retrigger above to start a fresh attempt.
          </div>
        )}

        {/* Manual-recovery panel — visible whenever the worker did NOT reach
            the confirmation page. Surfaces the stop reason in plain English
            plus a checklist of artifacts the user can use to finish manually. */}
        {(deriveOutcome(submission) === "partial" || deriveOutcome(submission) === "failed") && (() => {
          const isPartial = deriveOutcome(submission) === "partial";
          const hasResume = !!submission.resumeUrl;
          const hasJobUrl = !!submission.jobUrl;
          const hasCreds = !!tenantCreds;
          const answerCount = submission.subjectiveAnswers?.length ?? 0;
          // Category-specific title + guidance, falling back to a generic
          // pair when the worker didn't classify (legacy records, edge
          // failures). The stoppedReason is shown as a smaller mono line
          // underneath so the user sees both the classification AND the
          // raw machine-generated reason.
          const cat = submission.failureCategory && FAILURE_GUIDANCE[submission.failureCategory];
          const title = cat?.title ?? (isPartial ? "Pick up manually" : "Did not submit");
          const guidance = cat?.guidance ?? "Sign in with the credentials below, open the job posting, upload the tailored resume, and use the answers we already gave to fill in any remaining steps.";
          const rawReason = submission.stoppedReason ?? submission.errorMessage;
          // Job-posting-dead is a special case: the listing is gone, so
          // none of the recovery checklist (resume, creds, answers) is
          // useful. Hide the checklist and lean into "find a fresh URL".
          const isDeadListing = submission.failureCategory === "job_posting_dead";
          return (
            <div className={`rounded-2xl border p-5 ${isPartial ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200"}`}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <p className={`text-[10px] font-semibold uppercase tracking-wider ${isPartial ? "text-amber-700" : "text-red-700"}`}>
                    {isPartial ? "Pick up manually" : "Did not submit — manual recovery"}
                  </p>
                  <h2 className={`text-sm font-semibold mt-0.5 ${isPartial ? "text-amber-900" : "text-red-900"}`}>
                    {title}
                  </h2>
                  {rawReason && (
                    <p className={`text-[11px] font-mono mt-1 select-text ${isPartial ? "text-amber-700" : "text-red-700"}`}>
                      {rawReason}
                    </p>
                  )}
                </div>
              </div>
              <p className={`text-xs mb-3 leading-relaxed ${isPartial ? "text-amber-800" : "text-red-800"}`}>
                {guidance}
              </p>
              {!isDeadListing && (
              <ul className="text-xs space-y-1.5">
                <li className={isPartial ? "text-amber-900" : "text-red-900"}>
                  <span className="inline-block w-4">{hasResume ? "✓" : "·"}</span>
                  <span className={hasResume ? "" : "opacity-50"}>
                    Tailored resume
                    {hasResume && submission.resumeFilename ? ` — ${submission.resumeFilename}` : ""}
                    {!hasResume && " (not captured for this run)"}
                  </span>
                </li>
                <li className={isPartial ? "text-amber-900" : "text-red-900"}>
                  <span className="inline-block w-4">{hasJobUrl ? "✓" : "·"}</span>
                  <span className={hasJobUrl ? "" : "opacity-50"}>Job posting URL</span>
                </li>
                <li className={isPartial ? "text-amber-900" : "text-red-900"}>
                  <span className="inline-block w-4">{hasCreds ? "✓" : "·"}</span>
                  <span className={hasCreds ? "" : "opacity-50"}>
                    Workday account credentials
                    {!hasCreds && " (no creds stored — would need to create the account manually)"}
                  </span>
                </li>
                <li className={isPartial ? "text-amber-900" : "text-red-900"}>
                  <span className="inline-block w-4">{answerCount > 0 ? "✓" : "·"}</span>
                  <span className={answerCount > 0 ? "" : "opacity-50"}>
                    Application answers ({answerCount} {answerCount === 1 ? "field" : "fields"} the worker already filled)
                  </span>
                </li>
              </ul>
              )}
            </div>
          );
        })()}

        {/* Raw error message — kept as a separate fallback panel for runs
            that errored before the wizard even started (e.g. tailoring or
            createAccount throws). Suppressed when the recovery panel above
            is showing the same info — would otherwise duplicate the message. */}
        {submission.errorMessage && deriveOutcome(submission) !== "partial" && deriveOutcome(submission) !== "failed" && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-red-700 uppercase tracking-wider">Error</p>
            <p className="text-sm text-red-700 mt-1 whitespace-pre-wrap font-mono">{submission.errorMessage}</p>
          </div>
        )}

        {/* Job posting — visible URL + copy + open */}
        {submission.jobUrl && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-neutral-900">Job Posting</h2>
                <p className="text-[11px] text-neutral-400 mt-0.5">Public Workday URL — open to view the full JD or share with someone.</p>
                <a
                  href={submission.jobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-indigo-600 hover:text-indigo-700 break-all mt-2 block select-text"
                >
                  {submission.jobUrl}
                </a>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <CopyButton text={submission.jobUrl} label="Copy URL" />
                <a
                  href={submission.jobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                >
                  Open ↗
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Workday account credentials used for this application */}
        {tenantCreds && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Workday Account</h2>
                <p className="text-[11px] text-neutral-400 mt-0.5">Used to submit this application — keep these handy if you need to manually sign in to check status.</p>
              </div>
              <a
                href={`https://${tenantCreds.tenantHost}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-indigo-600 hover:text-indigo-700 font-medium whitespace-nowrap"
              >
                Open portal ↗
              </a>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-neutral-50 rounded-lg p-3">
                <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Email</p>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <code className="text-xs text-neutral-800 select-text break-all">{tenantCreds.email}</code>
                  <CopyButton text={tenantCreds.email} />
                </div>
              </div>
              <div className="bg-neutral-50 rounded-lg p-3">
                <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Password</p>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <code className="text-xs text-neutral-800 select-text font-mono break-all">
                    {revealPassword ? tenantCreds.password : "••••••••••••"}
                  </code>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setRevealPassword((v) => !v)}
                      className="text-[11px] text-indigo-600 hover:text-indigo-700 font-medium"
                    >
                      {revealPassword ? "Hide" : "Reveal"}
                    </button>
                    <CopyButton text={tenantCreds.password} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tailored resume — always rendered when we have an applicationId,
            so the card is a consistent surface across every submission. The
            inner content reflects what was actually captured at apply time:
            preview if we have the JSON, download if we have the Blob URL,
            an honest "(not captured for this run)" note if neither was
            uploaded. We never tailor on demand here — the dashboard is a
            historical record of what was applied with, not a re-tailor surface. */}
        {id && (() => {
          const hasJson = !!submission.tailoredResumeJson;
          const hasUrl = !!submission.resumeUrl;
          const uploadError = submission.resumeUploadError;
          const captured = hasJson || hasUrl;
          return (
            <div className="bg-white rounded-2xl border border-neutral-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <button
                  type="button"
                  onClick={() => setResumeOpen((v) => !v)}
                  disabled={!hasJson}
                  className="flex items-center gap-2 text-sm font-semibold text-neutral-900 hover:text-indigo-600 transition-colors disabled:cursor-default disabled:hover:text-neutral-900"
                >
                  {hasJson && <span className="text-xs">{resumeOpen ? "▼" : "▶"}</span>}
                  Tailored Resume
                  {!resumeOpen && hasJson && (
                    <span className="text-[11px] text-neutral-400 font-normal">
                      (click to expand)
                    </span>
                  )}
                  {!captured && !uploadError && (
                    <span className="text-[11px] text-neutral-400 font-normal">
                      (not captured for this run)
                    </span>
                  )}
                  {!captured && uploadError && (
                    <span className="text-[11px] text-red-600 font-normal">
                      (upload failed)
                    </span>
                  )}
                </button>
                <div className="flex items-center gap-2">
                  {submission.tailoringCostCents != null && (
                    <span className="text-[11px] text-neutral-400">{submission.tailoringCostCents.toFixed(1)}¢ to tailor</span>
                  )}
                  {hasUrl && (
                    <a
                      href={`/api/applications/${id}/resume`}
                      className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
                    >
                      ↓ Resume
                    </a>
                  )}
                </div>
              </div>
              {resumeOpen && hasJson && submission.tailoredResumeJson && (
                <TailoredResumeView resume={submission.tailoredResumeJson} />
              )}
              {!captured && uploadError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-[11px] font-semibold text-red-700 uppercase tracking-wider">
                    Resume upload to Blob failed
                  </p>
                  <p className="text-xs text-red-700 mt-1 font-mono whitespace-pre-wrap select-text leading-relaxed">
                    {uploadError}
                  </p>
                  <p className="text-[11px] text-red-600 mt-2 leading-relaxed">
                    The application may still have completed — Workday received the .docx during
                    the wizard upload step. Only the dashboard&apos;s archival copy is missing.
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        {/* Per-app cost breakdown — renders nothing if no cost events
            recorded yet (legacy applications, or runs that didn't hit
            any LLM call). */}
        {id && <CostBreakdown applicationId={id} />}

        {/* Cover letter — full text, copyable */}
        {submission.coverLetter && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-neutral-900">Cover Letter</h2>
              <CopyButton text={submission.coverLetter} label="Copy cover letter" />
            </div>
            <div className="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed select-text">
              {submission.coverLetter}
            </div>
          </div>
        )}

        {/* Application Q&A — every form field the worker filled, in order.
            Critical for manual recovery on partial/failed runs (the user
            shouldn't retype answers we already gave). For successful runs
            it's a useful audit trail. */}
        {submission.subjectiveAnswers && submission.subjectiveAnswers.length > 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Application Answers</h2>
                <p className="text-[11px] text-neutral-400 mt-0.5">
                  {submission.subjectiveAnswers.length} field{submission.subjectiveAnswers.length === 1 ? "" : "s"} the worker filled across the wizard. Use these to finish the application manually if needed.
                </p>
              </div>
              <CopyButton
                text={submission.subjectiveAnswers
                  .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
                  .join("\n\n")}
                label="Copy all"
              />
            </div>
            <div className="space-y-3">
              {submission.subjectiveAnswers.map((a, i) => (
                <div key={i} className="border-l-2 border-indigo-100 pl-3 py-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-neutral-700 select-text leading-snug">{a.question}</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {a.pageHeader && (
                        <span className="text-[10px] text-neutral-400 whitespace-nowrap">{a.pageHeader}</span>
                      )}
                      <CopyButton text={a.answer} />
                    </div>
                  </div>
                  <p className="text-xs text-neutral-900 mt-1 whitespace-pre-wrap select-text leading-relaxed">{a.answer}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* What Claude changed */}
        {submission.tailoringChanges && submission.tailoringChanges.length > 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <h2 className="text-sm font-semibold text-neutral-900 mb-3">
              Changes Claude made ({submission.tailoringChanges.length})
            </h2>
            <ul className="space-y-2">
              {submission.tailoringChanges.map((c, i) => (
                <li key={i} className="text-xs text-neutral-600 select-text">
                  <span className="inline-block bg-indigo-50 text-indigo-700 text-[10px] font-medium px-1.5 py-0.5 rounded mr-1.5">
                    {c.category}
                  </span>
                  {c.text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Screenshots */}
        <div className="bg-white rounded-2xl border border-neutral-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-neutral-900">Evidence Screenshots</h2>
            <span className="text-xs text-neutral-400">{submission.screenshots?.length ?? 0} captured</span>
          </div>

          {(!submission.screenshots || submission.screenshots.length === 0) ? (
            <div className="text-center py-12">
              <p className="text-sm text-neutral-400">
                {submission.status === "in_progress"
                  ? "Screenshots will appear as the worker walks the wizard…"
                  : "No screenshots were captured for this submission."}
              </p>
              {!submission.screenshots?.length && submission.status !== "in_progress" && (
                <p className="text-[11px] text-neutral-300 mt-2">
                  (Worker may not have BLOB_READ_WRITE_TOKEN configured — check the dev terminal for [submissions] warnings.)
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {submission.screenshots.map((shot, i) => (
                <button
                  key={`${shot.step}-${i}`}
                  onClick={() => setZoomedShot(shot.url)}
                  className="text-left group"
                >
                  <div className="aspect-[4/3] bg-neutral-100 rounded-lg border border-neutral-200 overflow-hidden group-hover:border-indigo-300 transition-colors">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={shot.url} alt={shot.step} className="w-full h-full object-cover object-top" />
                  </div>
                  <p className="text-xs font-medium text-neutral-700 mt-2 truncate">{shot.step}</p>
                  {shot.pageHeader && (
                    <p className="text-[11px] text-neutral-400 truncate">{shot.pageHeader}</p>
                  )}
                  <p className="text-[10px] text-neutral-300 mt-0.5">{fmtTime(shot.capturedAt)}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Steps */}
        {submission.steps?.length > 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <h2 className="text-sm font-semibold text-neutral-900 mb-3">Step Log</h2>
            <ol className="space-y-3">
              {submission.steps.map((step, i) => (
                <li key={i} className="flex items-start gap-3 text-xs">
                  <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                    step.status === "completed" ? "bg-emerald-500"
                      : step.status === "failed" ? "bg-red-500"
                      : step.status === "running" ? "bg-blue-500 animate-pulse"
                      : "bg-neutral-300"
                  }`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-neutral-800 font-medium select-text">{step.name}</p>
                      {(step.note || step.error) && (
                        <CopyButton text={[step.name, step.note, step.error].filter(Boolean).join("\n")} />
                      )}
                    </div>
                    {step.note && <p className="text-neutral-600 mt-1 leading-relaxed select-text">{step.note}</p>}
                    {step.error && <p className="text-red-600 mt-1 font-mono select-text whitespace-pre-wrap">{step.error}</p>}
                  </div>
                  <span className="text-neutral-300 shrink-0 tabular-nums">
                    {step.durationMs != null ? `${(step.durationMs / 1000).toFixed(1)}s` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {/* Zoomed screenshot modal */}
      {zoomedShot && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setZoomedShot(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomedShot} alt="Zoomed screenshot" className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}
