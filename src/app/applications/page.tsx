"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SubmissionRecord, SubmissionOutcome } from "@/lib/submissions";
import { deriveOutcome, FAILURE_GUIDANCE } from "@/lib/submissions";

function formatRelativeDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 14) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDuration(start?: string, end?: string): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

/**
 * Outcome buckets: "completed" was previously single-mapped to "Submitted",
 * but the worker writes status="completed" on any clean exit — including
 * partial advances that never actually clicked Submit successfully. We split
 * on the new `applicationSubmitted` flag (or, for legacy records without it,
 * the presence of a step="confirmation" screenshot) so the dashboard stops
 * lying about what was actually submitted.
 */
const OUTCOME_STYLES: Record<SubmissionOutcome, string> = {
  running: "bg-blue-100 text-blue-700",
  awaiting_review: "bg-amber-100 text-amber-800 ring-2 ring-amber-400",
  submitted: "bg-emerald-100 text-emerald-700",
  already_applied: "bg-teal-100 text-teal-700",
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
};

const OUTCOME_LABEL: Record<SubmissionOutcome, string> = {
  running: "Running",
  awaiting_review: "Review needed",
  submitted: "Submitted",
  already_applied: "Already Applied",
  partial: "Partial",
  failed: "Failed",
};

export default function ApplicationsPage() {
  const router = useRouter();
  const [submissions, setSubmissions] = useState<SubmissionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/applications");
        if (!res.ok) {
          if (res.status === 401) {
            setError("Sign in to see your submissions.");
          } else {
            setError(`Failed to load: ${res.status}`);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) setSubmissions(data.submissions ?? []);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    // Poll every 10s — submissions in_progress will update as the worker writes
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const counts = submissions
    ? (() => {
        const outcomes = submissions.map(deriveOutcome);
        return {
          all: submissions.length,
          running: outcomes.filter((o) => o === "running").length,
          awaiting: outcomes.filter((o) => o === "awaiting_review").length,
          submitted: outcomes.filter((o) => o === "submitted" || o === "already_applied").length,
          partial: outcomes.filter((o) => o === "partial").length,
          failed: outcomes.filter((o) => o === "failed").length,
        };
      })()
    : null;

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-[1600px] mx-auto">
          <h1 className="text-2xl font-bold">Submissions</h1>
          <p className="text-indigo-300 text-sm mt-1">
            Every application the worker has run for you, with the
            tailored resume, cover letter, and step-by-step evidence.
            Auto-refreshes every 10s.
          </p>
          {counts && (
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mt-6">
              {[
                { label: "All", value: counts.all, accent: "text-white" },
                { label: "Running", value: counts.running, accent: counts.running > 0 ? "text-blue-300" : "text-indigo-200" },
                { label: "Awaiting", value: counts.awaiting, accent: counts.awaiting > 0 ? "text-amber-300" : "text-indigo-200" },
                { label: "Submitted", value: counts.submitted, accent: counts.submitted > 0 ? "text-emerald-300" : "text-indigo-200" },
                { label: "Partial", value: counts.partial, accent: counts.partial > 0 ? "text-amber-300" : "text-indigo-200" },
                { label: "Failed", value: counts.failed, accent: counts.failed > 0 ? "text-red-300" : "text-indigo-200" },
              ].map((kpi) => (
                <div key={kpi.label} className="rounded-xl bg-white/10 backdrop-blur p-3.5">
                  <p className="text-[10px] text-indigo-300 font-semibold uppercase tracking-wider">{kpi.label}</p>
                  <p className={`text-2xl font-bold mt-1 tabular-nums ${kpi.accent}`}>{kpi.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-6 py-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-4 text-sm">{error}</div>
        )}

        {submissions === null && !error && (
          <div className="text-center py-20 text-neutral-400 text-sm">Loading…</div>
        )}

        {submissions && submissions.length === 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-10 text-center">
            <p className="text-sm font-semibold text-neutral-700">No submissions yet</p>
            <p className="text-xs text-neutral-400 mt-1 max-w-md mx-auto">
              Capture jobs in the{" "}
              <Link href="/console" className="text-indigo-600 hover:text-indigo-700 underline">
                Console
              </Link>
              {" "}and click Apply — the worker will run them and write here as
              each application progresses.
            </p>
          </div>
        )}

        {submissions && submissions.length > 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "160px" }} />
                <col style={{ width: "300px" }} />
                <col style={{ width: "80px" }} />
                <col style={{ width: "70px" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: "140px" }} />
                <col style={{ width: "100px" }} />
                <col style={{ width: "140px" }} />
              </colgroup>
              <thead>
                <tr className="text-[11px] uppercase text-neutral-400 tracking-wider border-b border-neutral-100">
                  <th className="text-left px-5 py-3 font-semibold border-r border-neutral-100">Company</th>
                  <th className="text-left px-3 py-3 font-semibold border-r border-neutral-100">Title</th>
                  <th className="text-left px-3 py-3 font-semibold border-r border-neutral-100">Status</th>
                  <th className="text-left px-3 py-3 font-semibold border-r border-neutral-100">Match</th>
                  <th className="text-left px-3 py-3 font-semibold border-r border-neutral-100">Started</th>
                  <th className="text-left px-3 py-3 font-semibold border-r border-neutral-100">Duration</th>
                  <th className="text-left px-3 py-3 font-semibold border-r border-neutral-100">Failure</th>
                  <th className="text-left px-3 py-3 font-semibold border-r border-neutral-100">Cost</th>
                  <th className="text-right px-5 py-3 font-semibold">Retry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {submissions.map((s) => (
                  <SubmissionRow
                    key={s.applicationId}
                    submission={s}
                    onRowClick={() => router.push(`/applications/${s.applicationId}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One row in the Submissions table. Encapsulates the inline-editable
 * remark + retrigger button — both need their own state and click
 * handlers, which would clutter the parent's JSX.
 *
 * Click anywhere on the row drills into /applications/[id], EXCEPT on
 * the remark textarea or the retrigger button (their handlers stop
 * propagation so editing/retriggering doesn't accidentally navigate).
 */
function SubmissionRow({
  submission,
  onRowClick,
}: {
  submission: SubmissionRecord;
  onRowClick: () => void;
}) {
  const outcome = deriveOutcome(submission);
  const failure = submission.failureCategory
    ? FAILURE_GUIDANCE[submission.failureCategory]?.shortLabel
    : null;
  const failureFullTitle = submission.failureCategory
    ? FAILURE_GUIDANCE[submission.failureCategory]?.title
    : null;
  const failureDetail = submission.stoppedReason ?? submission.errorMessage ?? null;
  // Tooltip on the cell shows the full descriptive title + raw reason so
  // the 3-word label doesn't lose information — hover to read the whole
  // story.
  const failureTooltip = [failureFullTitle, failureDetail].filter(Boolean).join("\n\n");

  // Retrigger opens the actual Workday job URL in a new tab. The Chrome
  // extension (chrome-extension/ats/workday.js) detects the Workday page
  // on page load and offers to auto-fill from the user's stored profile
  // + tailored resume. Anything the headless worker couldn't get past
  // (CAPTCHA, tenant-specific selectors, ambiguous form fields) the user
  // handles in their own browser session — residential IP, real cookies,
  // human-in-the-loop. Server retrigger via dispatcher is intentionally
  // NOT triggered here: re-running the same headless path against the
  // same blocker would just fail again. The user can still re-queue
  // explicitly from /console if they want to retry the worker path.
  const onRetrigger = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!submission.jobUrl) return;
    window.open(submission.jobUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <tr
      onClick={onRowClick}
      className="hover:bg-indigo-50/50 cursor-pointer transition-colors"
    >
      <td className="px-5 py-3 border-r border-neutral-100">
        <p className="font-medium text-neutral-900 truncate" title={submission.company}>{submission.company}</p>
        {submission.tenant && (
          <p className="text-[10px] text-neutral-400 mt-0.5 truncate">{submission.tenant}</p>
        )}
      </td>
      <td className="px-3 py-3 border-r border-neutral-100">
        <p className="text-neutral-700 truncate" title={submission.jobTitle}>
          {submission.jobTitle}
        </p>
      </td>
      <td className="px-3 py-3 border-r border-neutral-100">
        <span
          className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${OUTCOME_STYLES[outcome]}`}
          title={
            outcome === "running" && submission.currentActivity
              ? submission.currentActivity
              : outcome === "partial"
                ? (submission.stoppedReason ?? "Wizard advanced but did not reach the confirmation page")
                : undefined
          }
        >
          {OUTCOME_LABEL[outcome]}
        </span>
        {/* Live activity sub-text — pulses while the worker is mid-run.
            Hover the Status badge for the same text in tooltip form. */}
        {outcome === "running" && submission.currentActivity && (
          <p className="text-[10px] text-blue-600 mt-1 truncate flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>
            </span>
            <span className="truncate">{submission.currentActivity}</span>
          </p>
        )}
      </td>
      <td className="px-3 py-3 whitespace-nowrap border-r border-neutral-100">
        {submission.matchScore != null ? (
          <span className={`text-xs font-bold tabular-nums ${
            submission.matchScore >= 80 ? "text-emerald-600" :
            submission.matchScore >= 60 ? "text-amber-600" :
            "text-neutral-400"
          }`}>
            {submission.matchScore}
            {submission.originalMatchScore != null && submission.matchScore > submission.originalMatchScore && (
              <span className="text-[10px] text-emerald-500 font-normal ml-1">
                +{submission.matchScore - submission.originalMatchScore}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-neutral-300">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-neutral-500 whitespace-nowrap border-r border-neutral-100">
        {formatRelativeDate(submission.startedAt)}
      </td>
      <td className="px-3 py-3 text-neutral-500 whitespace-nowrap tabular-nums border-r border-neutral-100">
        {formatDuration(submission.startedAt, submission.completedAt)}
      </td>
      <td className="px-3 py-3 border-r border-neutral-100" title={failureTooltip || undefined}>
        {failure ? (
          <p className="text-xs text-red-700 font-medium whitespace-nowrap">{failure}</p>
        ) : failureDetail ? (
          <p className="text-xs text-neutral-500 truncate">{failureDetail}</p>
        ) : (
          <span className="text-xs text-neutral-300">—</span>
        )}
      </td>
      <td className="px-3 py-3 whitespace-nowrap border-r border-neutral-100">
        {/* Placeholder until per-stage cost analytics ships. Today we only
            know the tailoring cost; total per-app cost across all stages
            (parse, analyze, answer-questions) isn't tracked yet. */}
        {submission.tailoringCostCents != null ? (
          <span
            className="text-xs text-neutral-600 tabular-nums"
            title="Tailoring step only — full per-stage breakdown coming with cost-analytics"
          >
            {submission.tailoringCostCents.toFixed(1)}¢
            <span className="text-[10px] text-neutral-300 ml-1">tailor</span>
          </span>
        ) : (
          <span
            className="text-xs text-neutral-300"
            title="Cost analytics not yet wired for this run"
          >
            —
          </span>
        )}
      </td>
      <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onRetrigger}
          disabled={!submission.jobUrl}
          className="text-xs bg-indigo-600 hover:bg-indigo-700 disabled:bg-neutral-300 disabled:cursor-not-allowed text-white font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          title="Open the job posting in a new tab. The Chrome extension takes over from there to auto-fill the form."
        >
          Open & retry ↗
        </button>
      </td>
    </tr>
  );
}
