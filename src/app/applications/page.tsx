"use client";

import { useEffect, useRef, useState } from "react";
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
  submitted: "bg-emerald-100 text-emerald-700",
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
};

const OUTCOME_LABEL: Record<SubmissionOutcome, string> = {
  running: "Running",
  submitted: "Submitted",
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
          submitted: outcomes.filter((o) => o === "submitted").length,
          partial: outcomes.filter((o) => o === "partial").length,
          failed: outcomes.filter((o) => o === "failed").length,
        };
      })()
    : null;

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl font-bold">Submissions</h1>
          <p className="text-indigo-300 text-sm mt-1">
            Every Workday application the worker has run for you, with the
            tailored resume, cover letter, and step-by-step evidence.
            Auto-refreshes every 10s.
          </p>
          {counts && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-6">
              {[
                { label: "All", value: counts.all, accent: "text-white" },
                { label: "Running", value: counts.running, accent: counts.running > 0 ? "text-blue-300" : "text-indigo-200" },
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

      <div className="max-w-6xl mx-auto px-6 py-6">
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
          <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase text-neutral-400 tracking-wider border-b border-neutral-100">
                  <th className="text-left px-5 py-3 font-semibold">Company</th>
                  <th className="text-left px-3 py-3 font-semibold">Title</th>
                  <th className="text-left px-3 py-3 font-semibold">Status</th>
                  <th className="text-left px-3 py-3 font-semibold">Match</th>
                  <th className="text-left px-3 py-3 font-semibold">Started</th>
                  <th className="text-left px-3 py-3 font-semibold">Duration</th>
                  <th className="text-left px-3 py-3 font-semibold">Failure reason</th>
                  <th className="text-left px-3 py-3 font-semibold">Cost</th>
                  <th className="text-left px-3 py-3 font-semibold">Remark</th>
                  <th className="text-right px-5 py-3 font-semibold">Retrigger</th>
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
    ? FAILURE_GUIDANCE[submission.failureCategory]?.title
    : null;
  const failureDetail = submission.stoppedReason ?? submission.errorMessage ?? null;

  // Locally-edited remark with debounced save. We don't update the parent's
  // submissions array on save — the next 10s auto-refresh picks it up.
  const [remark, setRemark] = useState<string>(submission.userRemark ?? "");
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onRemarkChange = (next: string) => {
    setRemark(next);
    setSavingState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/applications/${submission.applicationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userRemark: next }),
        });
        setSavingState(res.ok ? "saved" : "error");
        if (res.ok) {
          setTimeout(() => setSavingState("idle"), 1500);
        }
      } catch {
        setSavingState("error");
      }
    }, 800);
  };

  const [retriggering, setRetriggering] = useState(false);
  const onRetrigger = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRetriggering(true);
    try {
      const res = await fetch(
        `/api/applications/${submission.applicationId}/retrigger`,
        { method: "POST" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? `Retrigger failed: HTTP ${res.status}`);
        return;
      }
      // Open /console pipeline tab in a new browser tab so the user can
      // watch the retry run without losing their place on this list.
      window.open("/console", "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(`Retrigger failed: ${(err as Error).message}`);
    } finally {
      setRetriggering(false);
    }
  };

  return (
    <tr
      onClick={onRowClick}
      className="hover:bg-indigo-50/50 cursor-pointer transition-colors"
    >
      <td className="px-5 py-3">
        <p className="font-medium text-neutral-900">{submission.company}</p>
        {submission.tenant && (
          <p className="text-[10px] text-neutral-400 mt-0.5">{submission.tenant}</p>
        )}
      </td>
      <td className="px-3 py-3 max-w-[240px]">
        <p className="text-neutral-700 truncate">{submission.jobTitle}</p>
      </td>
      <td className="px-3 py-3">
        <span
          className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${OUTCOME_STYLES[outcome]}`}
          title={
            outcome === "partial"
              ? (submission.stoppedReason ?? "Wizard advanced but did not reach the confirmation page")
              : undefined
          }
        >
          {OUTCOME_LABEL[outcome]}
        </span>
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
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
      <td className="px-3 py-3 text-neutral-500 whitespace-nowrap">
        {formatRelativeDate(submission.startedAt)}
      </td>
      <td className="px-3 py-3 text-neutral-500 whitespace-nowrap tabular-nums">
        {formatDuration(submission.startedAt, submission.completedAt)}
      </td>
      <td className="px-3 py-3 max-w-[260px]">
        {failure ? (
          <div title={failureDetail ?? undefined}>
            <p className="text-xs text-red-700 font-medium truncate">{failure}</p>
            {failureDetail && (
              <p className="text-[10px] text-red-500 font-mono truncate">{failureDetail}</p>
            )}
          </div>
        ) : failureDetail ? (
          <p className="text-xs text-neutral-500 font-mono truncate" title={failureDetail}>
            {failureDetail}
          </p>
        ) : (
          <span className="text-xs text-neutral-300">—</span>
        )}
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
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
      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <div className="relative">
          <input
            type="text"
            value={remark}
            onChange={(e) => onRemarkChange(e.target.value)}
            placeholder="Add note…"
            maxLength={1000}
            className="w-full text-xs bg-transparent border border-neutral-200 hover:border-neutral-300 focus:border-indigo-400 focus:outline-none rounded px-2 py-1"
          />
          {savingState === "saving" && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-neutral-400">…</span>
          )}
          {savingState === "saved" && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-emerald-500">saved</span>
          )}
          {savingState === "error" && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-red-500">err</span>
          )}
        </div>
      </td>
      <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onRetrigger}
          disabled={retriggering || !submission.jobUrl}
          className="text-xs bg-indigo-600 hover:bg-indigo-700 disabled:bg-neutral-300 disabled:cursor-not-allowed text-white font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          title="Re-queue this application on the retry lane and open the Pipeline in a new tab"
        >
          {retriggering ? "Queuing…" : "Retrigger ↗"}
        </button>
      </td>
    </tr>
  );
}
