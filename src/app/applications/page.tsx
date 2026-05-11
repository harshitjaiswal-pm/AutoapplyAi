"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import type { SubmissionRecord, SubmissionOutcome } from "@/lib/submissions";
import { deriveOutcome, FAILURE_GUIDANCE } from "@/lib/submissions";

// ─── formatters ───────────────────────────────────────────────────────────────

function normalizeUrl(url: string) {
  return url.split("?")[0].replace(/\/+$/, "");
}

function localDateKey(iso?: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateLabel(dateKey: string): string {
  // Reconstruct as noon local to avoid any DST-at-midnight shift
  const d = new Date(`${dateKey}T12:00:00`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function fmtDuration(start?: string, end?: string): string {
  if (!start) return "—";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

// ─── data structures ──────────────────────────────────────────────────────────

/** All attempts for one unique job URL, newest attempt first. */
interface JobGroup {
  key: string;            // normalised jobUrl
  jobUrl: string;
  jobTitle: string;
  company: string;
  tenant?: string;
  attempts: SubmissionRecord[];  // sorted newest → oldest
}

interface DateGroup {
  dateKey: string;        // "YYYY-MM-DD"
  dateLabel: string;      // "Saturday, May 10, 2026"
  jobs: JobGroup[];       // sorted newest-attempt-first within date
  totalJobs: number;
  submittedJobs: number;  // jobs where ANY attempt reached confirmation
}

// ─── grouping ─────────────────────────────────────────────────────────────────

function isJobSubmitted(jg: JobGroup): boolean {
  return jg.attempts.some((a) => {
    const o = deriveOutcome(a);
    return o === "submitted" || o === "already_applied";
  });
}

function buildDateGroups(submissions: SubmissionRecord[]): DateGroup[] {
  // 1. Bucket by normalised URL
  const byUrl = new Map<string, SubmissionRecord[]>();
  for (const s of submissions) {
    if (!s.jobUrl) continue;
    const key = normalizeUrl(s.jobUrl);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key)!.push(s);
  }

  // 2. Build JobGroup — sort attempts newest → oldest
  const jobGroups: JobGroup[] = [];
  for (const [key, recs] of byUrl) {
    recs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    const latest = recs[0];
    jobGroups.push({
      key,
      jobUrl: key,
      jobTitle: latest.jobTitle || "Untitled",
      company: latest.company || key.split("/")[2]?.split(".")[0] || key,
      tenant: latest.tenant,
      attempts: recs,
    });
  }

  // 3. Bucket JobGroups by the date of their latest attempt
  const byDate = new Map<string, JobGroup[]>();
  for (const jg of jobGroups) {
    const dk = localDateKey(jg.attempts[0].startedAt);
    if (!byDate.has(dk)) byDate.set(dk, []);
    byDate.get(dk)!.push(jg);
  }

  // 4. Sort within each date (latest startedAt first), build DateGroup
  const dateGroups: DateGroup[] = [];
  for (const [dk, jobs] of byDate) {
    jobs.sort((a, b) =>
      (b.attempts[0].startedAt ?? "").localeCompare(a.attempts[0].startedAt ?? "")
    );
    dateGroups.push({
      dateKey: dk,
      dateLabel: fmtDateLabel(dk),
      jobs,
      totalJobs: jobs.length,
      submittedJobs: jobs.filter(isJobSubmitted).length,
    });
  }

  // 5. Sort date groups newest first
  dateGroups.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  return dateGroups;
}

// ─── outcome styling ──────────────────────────────────────────────────────────

const OUTCOME_STYLE: Record<SubmissionOutcome, string> = {
  running:         "bg-blue-100 text-blue-700",
  awaiting_review: "bg-amber-100 text-amber-800 ring-1 ring-amber-400",
  submitted:       "bg-emerald-100 text-emerald-700",
  already_applied: "bg-teal-100 text-teal-700",
  partial:         "bg-amber-50 text-amber-700",
  failed:          "bg-red-100 text-red-700",
};

const OUTCOME_LABEL: Record<SubmissionOutcome, string> = {
  running:         "Running",
  awaiting_review: "Needs review",
  submitted:       "Submitted",
  already_applied: "Already applied",
  partial:         "Partial",
  failed:          "Failed",
};

// ─── attempt history panel ────────────────────────────────────────────────────

function AttemptHistory({ attempts }: { attempts: SubmissionRecord[] }) {
  return (
    <tr>
      <td colSpan={7} className="bg-slate-50 border-b border-neutral-100 px-0 py-0">
        <div className="pl-[150px] pr-4 py-3">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-2">
            Retry history — {attempts.length} attempt{attempts.length !== 1 ? "s" : ""}
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-slate-400 uppercase tracking-wider">
                <th className="text-left pr-4 py-1 font-semibold w-[70px]">#</th>
                <th className="text-left pr-4 py-1 font-semibold w-[120px]">Status</th>
                <th className="text-left pr-4 py-1 font-semibold w-[90px]">Started</th>
                <th className="text-left pr-4 py-1 font-semibold w-[80px]">Duration</th>
                <th className="text-left pr-4 py-1 font-semibold">Stopped at</th>
                <th className="text-right py-1 font-semibold w-[80px]">Detail</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a, i) => {
                const o = deriveOutcome(a);
                const failLabel = a.failureCategory
                  ? FAILURE_GUIDANCE[a.failureCategory]?.shortLabel
                  : null;
                return (
                  <tr
                    key={a.applicationId}
                    className="border-t border-slate-100"
                  >
                    <td className="pr-4 py-2 font-medium text-slate-600">
                      #{attempts.length - i}
                      {i === 0 && (
                        <span className="ml-1.5 text-[9px] font-normal text-slate-400">
                          latest
                        </span>
                      )}
                    </td>
                    <td className="pr-4 py-2">
                      <span
                        className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${OUTCOME_STYLE[o]}`}
                      >
                        {OUTCOME_LABEL[o]}
                      </span>
                      {failLabel && (
                        <span className="ml-1.5 text-[10px] text-red-500">{failLabel}</span>
                      )}
                    </td>
                    <td className="pr-4 py-2 text-slate-500 whitespace-nowrap">
                      {fmtTime(a.startedAt)}
                    </td>
                    <td className="pr-4 py-2 text-slate-500 whitespace-nowrap tabular-nums">
                      {fmtDuration(a.startedAt, a.completedAt)}
                    </td>
                    <td
                      className="pr-4 py-2 text-slate-500 truncate max-w-[320px]"
                      title={a.stoppedReason ?? a.errorMessage ?? ""}
                    >
                      {a.stoppedReason ? (
                        a.stoppedReason.slice(0, 140)
                      ) : a.errorMessage ? (
                        a.errorMessage.slice(0, 140)
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Link
                        href={`/applications/${a.applicationId}`}
                        className="text-indigo-600 hover:text-indigo-800 hover:underline font-medium"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Detail →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  );
}

// ─── one job row ──────────────────────────────────────────────────────────────

function JobRow({ group }: { group: JobGroup }) {
  const [expanded, setExpanded] = useState(false);
  const latest = group.attempts[0];
  const latestOutcome = deriveOutcome(latest);

  // If the latest attempt didn't submit but an earlier one did, surface it.
  const appliedInEarlierAttempt =
    latestOutcome !== "submitted" &&
    latestOutcome !== "already_applied" &&
    group.attempts.slice(1).some((a) => {
      const o = deriveOutcome(a);
      return o === "submitted" || o === "already_applied";
    });

  const failLabel = latest.failureCategory
    ? FAILURE_GUIDANCE[latest.failureCategory]?.shortLabel
    : null;

  const tries = group.attempts.length;

  return (
    <>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="border-b border-neutral-100 hover:bg-indigo-50/30 cursor-pointer transition-colors"
      >
        {/* Company */}
        <td className="px-5 py-3 align-top">
          <p
            className="font-medium text-neutral-900 truncate leading-snug"
            title={group.company}
          >
            {group.company}
          </p>
          {group.tenant && (
            <p className="text-[10px] text-neutral-400 mt-0.5 truncate">
              {group.tenant}
            </p>
          )}
        </td>

        {/* Title */}
        <td className="px-3 py-3 align-top">
          <p className="text-sm text-neutral-700 truncate" title={group.jobTitle}>
            {group.jobTitle}
          </p>
        </td>

        {/* Status */}
        <td className="px-3 py-3 align-top">
          <div className="flex flex-col gap-0.5">
            <span
              className={`inline-block w-fit text-[10px] font-semibold px-2 py-0.5 rounded-full ${OUTCOME_STYLE[latestOutcome]}`}
              title={
                latestOutcome === "running" && latest.currentActivity
                  ? latest.currentActivity
                  : undefined
              }
            >
              {OUTCOME_LABEL[latestOutcome]}
            </span>
            {failLabel && latestOutcome === "failed" && (
              <span className="text-[10px] text-red-500 pl-0.5">{failLabel}</span>
            )}
            {appliedInEarlierAttempt && (
              <span className="text-[10px] text-emerald-600 pl-0.5">
                ✓ Applied in earlier attempt
              </span>
            )}
            {latestOutcome === "running" && latest.currentActivity && (
              <span className="text-[10px] text-blue-600 pl-0.5 truncate max-w-[160px]">
                {latest.currentActivity}
              </span>
            )}
          </div>
        </td>

        {/* Match score */}
        <td className="px-3 py-3 align-top whitespace-nowrap">
          {latest.matchScore != null ? (
            <span
              className={`text-xs font-bold tabular-nums ${
                latest.matchScore >= 80
                  ? "text-emerald-600"
                  : latest.matchScore >= 60
                  ? "text-amber-600"
                  : "text-neutral-400"
              }`}
            >
              {latest.matchScore}
              {latest.originalMatchScore != null &&
                latest.matchScore > latest.originalMatchScore && (
                  <span className="text-[10px] text-emerald-500 font-normal ml-1">
                    +{latest.matchScore - latest.originalMatchScore}
                  </span>
                )}
            </span>
          ) : (
            <span className="text-xs text-neutral-300">—</span>
          )}
        </td>

        {/* Tries */}
        <td className="px-3 py-3 align-top whitespace-nowrap">
          <span
            className={`text-xs tabular-nums ${
              tries > 1 ? "font-semibold text-amber-700" : "text-neutral-500"
            }`}
          >
            {tries}×
          </span>
        </td>

        {/* Duration */}
        <td className="px-3 py-3 align-top whitespace-nowrap text-xs text-neutral-500 tabular-nums">
          {fmtDuration(latest.startedAt, latest.completedAt)}
        </td>

        {/* Action */}
        <td
          className="px-5 py-3 align-top text-right"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() =>
                window.open(group.jobUrl, "_blank", "noopener,noreferrer")
              }
              title="Open job posting in a new tab"
              className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
            >
              Open ↗
            </button>
            <span
              className={`text-neutral-300 transition-transform duration-150 text-sm ${expanded ? "rotate-90" : ""}`}
            >
              ›
            </span>
          </div>
        </td>
      </tr>

      {expanded && <AttemptHistory attempts={group.attempts} />}
    </>
  );
}

// ─── date section ─────────────────────────────────────────────────────────────

function DateSection({ group }: { group: DateGroup }) {
  const pct =
    group.totalJobs > 0
      ? Math.round((group.submittedJobs / group.totalJobs) * 100)
      : 0;

  return (
    <section className="mb-10">
      {/* Date header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
            {group.dateLabel}
          </h2>
          <div className="flex items-center gap-1.5 text-xs text-neutral-400">
            <span>
              {group.totalJobs} job{group.totalJobs !== 1 ? "s" : ""}
            </span>
            <span>·</span>
            <span
              className={
                group.submittedJobs > 0
                  ? "text-emerald-600 font-semibold"
                  : "text-neutral-400"
              }
            >
              {group.submittedJobs} submitted
            </span>
            {group.totalJobs > 0 && (
              <>
                <span>·</span>
                <span
                  className={
                    pct >= 80
                      ? "text-emerald-500 font-semibold"
                      : pct >= 50
                      ? "text-amber-500"
                      : "text-neutral-400"
                  }
                >
                  {pct}%
                </span>
              </>
            )}
          </div>
        </div>
        {/* Progress bar */}
        {group.totalJobs > 0 && (
          <div className="w-24 h-1.5 bg-neutral-200 rounded-full overflow-hidden flex-shrink-0">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${pct}%`,
                backgroundColor:
                  pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#e5e7eb",
              }}
            />
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "150px" }} />
            <col /> {/* title: flex */}
            <col style={{ width: "140px" }} />
            <col style={{ width: "65px" }} />
            <col style={{ width: "52px" }} />
            <col style={{ width: "80px" }} />
            <col style={{ width: "120px" }} />
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase text-neutral-400 tracking-wider border-b border-neutral-100 bg-neutral-50">
              <th className="text-left px-5 py-2.5 font-semibold">Company</th>
              <th className="text-left px-3 py-2.5 font-semibold">Title</th>
              <th className="text-left px-3 py-2.5 font-semibold">Status</th>
              <th className="text-left px-3 py-2.5 font-semibold">Match</th>
              <th className="text-left px-3 py-2.5 font-semibold">Tries</th>
              <th className="text-left px-3 py-2.5 font-semibold">Time</th>
              <th className="text-right px-5 py-2.5 font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {group.jobs.map((jg) => (
              <JobRow key={jg.key} group={jg} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function ApplicationsPage() {
  const [submissions, setSubmissions] = useState<SubmissionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/applications");
        if (!res.ok) {
          setError(
            res.status === 401
              ? "Sign in to see your submissions."
              : `Failed to load: HTTP ${res.status}`
          );
          return;
        }
        const data = await res.json();
        if (!cancelled) setSubmissions(data.submissions ?? []);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const dateGroups = useMemo(
    () => (submissions ? buildDateGroups(submissions) : []),
    [submissions]
  );

  const kpis = useMemo(() => {
    if (!dateGroups.length) return null;
    const allJobs = dateGroups.flatMap((d) => d.jobs);
    return {
      uniqueJobs: allJobs.length,
      totalAttempts: allJobs.reduce((n, jg) => n + jg.attempts.length, 0),
      running: allJobs.filter(
        (jg) => deriveOutcome(jg.attempts[0]) === "running"
      ).length,
      awaiting: allJobs.filter(
        (jg) => deriveOutcome(jg.attempts[0]) === "awaiting_review"
      ).length,
      submitted: allJobs.filter(isJobSubmitted).length,
    };
  }, [dateGroups]);

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* ── header ── */}
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-[1400px] mx-auto">
          <h1 className="text-2xl font-bold">Submissions</h1>
          <p className="text-indigo-300 text-sm mt-1">
            Every application the worker has run for you — one row per job,
            click to see full retry history. Groups by date of last attempt.
            Auto-refreshes every 10s.
          </p>

          {kpis && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-6">
              {[
                {
                  label: "Unique jobs",
                  value: kpis.uniqueJobs,
                  accent: "text-white",
                },
                {
                  label: "Total attempts",
                  value: kpis.totalAttempts,
                  accent: "text-indigo-200",
                },
                {
                  label: "Running",
                  value: kpis.running,
                  accent:
                    kpis.running > 0 ? "text-blue-300" : "text-indigo-300",
                },
                {
                  label: "Awaiting review",
                  value: kpis.awaiting,
                  accent:
                    kpis.awaiting > 0 ? "text-amber-300" : "text-indigo-300",
                },
                {
                  label: "Submitted",
                  value: kpis.submitted,
                  accent:
                    kpis.submitted > 0 ? "text-emerald-300" : "text-indigo-300",
                },
              ].map((k) => (
                <div
                  key={k.label}
                  className="rounded-xl bg-white/10 backdrop-blur p-3.5"
                >
                  <p className="text-[10px] text-indigo-300 font-semibold uppercase tracking-wider">
                    {k.label}
                  </p>
                  <p
                    className={`text-2xl font-bold mt-1 tabular-nums ${k.accent}`}
                  >
                    {k.value}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── body ── */}
      <div className="max-w-[1400px] mx-auto px-6 py-8">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-6 text-sm">
            {error}
          </div>
        )}

        {submissions === null && !error && (
          <div className="text-center py-20 text-neutral-400 text-sm">
            Loading…
          </div>
        )}

        {submissions !== null && dateGroups.length === 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-12 text-center">
            <p className="text-sm font-semibold text-neutral-700">
              No submissions yet
            </p>
            <p className="text-xs text-neutral-400 mt-1 max-w-md mx-auto">
              Capture jobs in the{" "}
              <a
                href="/console"
                className="text-indigo-600 hover:text-indigo-700 underline"
              >
                Console
              </a>{" "}
              and click Apply — the worker will run them and write here as each
              application progresses.
            </p>
          </div>
        )}

        {dateGroups.map((dg) => (
          <DateSection key={dg.dateKey} group={dg} />
        ))}
      </div>
    </div>
  );
}
