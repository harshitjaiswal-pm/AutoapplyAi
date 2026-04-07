"use client";

import { useState, useEffect } from "react";
import { useAppStore, PipelineJob, Application, ResumeDefect } from "@/store/useAppStore";

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Types                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

interface TrackableJob {
  id: string;
  jobTitle: string;
  company: string;
  jobUrl?: string;
  score: number;
  originalScore: number;
  status: string;
  date: string;
  source: "pipeline" | "manual";
  defects?: ResumeDefect[];
  sourceYears?: number;
  tailoredYears?: number;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Page                                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

export default function DashboardPage() {
  const {
    applications,
    pipelineJobs,
    updateApplicationStatus,
    updatePipelineJob,
    addApplication,
  } = useAppStore();

  // Sync completed applications from Chrome extension via pipeline-bridge.js
  useEffect(() => {
    function syncCompleted() {
      try {
        const stored = localStorage.getItem("autoapply-completed-applications");
        if (!stored) return;
        const completed = JSON.parse(stored);
        if (!Array.isArray(completed)) return;

        for (const app of completed) {
          const existsInApps = applications.some(
            (a) => a.jobTitle === app.jobTitle && a.company === app.company
          );
          const existsInPipeline = pipelineJobs.some(
            (j) => j.jobTitle === app.jobTitle && j.company === app.company
          );

          if (!existsInApps && !existsInPipeline) {
            addApplication({
              id: app.id || `ext_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              jobTitle: app.jobTitle,
              company: app.company,
              jobUrl: app.jobUrl,
              status: "applied",
              appliedAt: app.completedAt || new Date().toISOString(),
              resumeVersion: "auto-applied",
              matchScore: app.matchScore || 0,
            });
          } else if (existsInPipeline) {
            const pj = pipelineJobs.find(
              (j) => j.jobTitle === app.jobTitle && j.company === app.company
            );
            if (pj && pj.status !== "applied") {
              updatePipelineJob(pj.id, {
                status: "applied",
                appliedAt: app.completedAt || new Date().toISOString(),
              });
            }
          }
        }
        localStorage.removeItem("autoapply-completed-applications");
      } catch (e) {
        console.warn("Dashboard: Error syncing completed applications", e);
      }
    }

    syncCompleted();
    window.addEventListener("autoapply-completed-sync", syncCompleted);
    return () => window.removeEventListener("autoapply-completed-sync", syncCompleted);
  }, [applications, pipelineJobs, addApplication, updatePipelineJob]);

  /* ── Build unified job list ─────────────────────────────────────────────── */
  const trackableJobs: TrackableJob[] = [
    ...pipelineJobs
      .filter((j) =>
        j.status === "ready" ||
        j.status === "applied" ||
        j.status === "skipped" ||
        j.status === "failed"
      )
      .map((j) => ({
        id: j.id,
        jobTitle: j.jobTitle,
        company: j.company,
        jobUrl: j.jobUrl,
        score: j.tailoredScore ?? 0,
        originalScore: j.originalScore ?? 0,
        status: j.status === "ready" ? "matched" : j.status,
        date: j.appliedAt ?? j.processedAt ?? j.addedAt,
        source: "pipeline" as const,
      })),
    ...applications.map((a) => ({
      id: a.id,
      jobTitle: a.jobTitle,
      company: a.company,
      jobUrl: a.jobUrl,
      score: a.matchScore,
      originalScore: 0,
      status: a.status,
      date: a.appliedAt,
      source: "manual" as const,
      defects: a.defects,
      sourceYears: a.sourceYears,
      tailoredYears: a.tailoredYears,
    })),
  ];

  /* ── Metrics ────────────────────────────────────────────────────────────── */
  const totalApplied =
    pipelineJobs.filter((j) => j.status === "applied").length +
    applications.filter((a) => a.status === "applied").length;

  const totalInterviewing = applications.filter(
    (a) => a.status === "interviewing"
  ).length;

  const totalOffers = applications.filter((a) => a.status === "offer").length;

  const allScored = trackableJobs.filter((j) => j.score > 0);
  const avgScore =
    allScored.length > 0
      ? Math.round(allScored.reduce((s, j) => s + j.score, 0) / allScored.length)
      : 0;

  const jobsWithDefects = trackableJobs.filter(
    (j) => j.defects && j.defects.length > 0
  );
  const defectRate =
    trackableJobs.length > 0
      ? Math.round((jobsWithDefects.length / trackableJobs.length) * 100)
      : 0;

  const errorCount = trackableJobs.reduce(
    (n, j) =>
      n + (j.defects?.filter((d) => d.severity === "error").length ?? 0),
    0
  );

  // Response rate: (interviewing + offers) / applied
  const responseRate =
    totalApplied > 0
      ? Math.round(((totalInterviewing + totalOffers) / totalApplied) * 100)
      : 0;

  const pipelineProcessing = pipelineJobs.filter(
    (j) => j.status === "analyzing" || j.status === "tailoring"
  ).length;
  const pipelineQueued = pipelineJobs.filter((j) => j.status === "queued").length;
  const pipelineReady = pipelineJobs.filter((j) => j.status === "ready").length;

  /* ── Filters ────────────────────────────────────────────────────────────── */
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [defectFilter, setDefectFilter] = useState<"all" | "defects-only" | "clean">("all");
  const [expandedDefect, setExpandedDefect] = useState<string | null>(null);

  const filteredJobs = trackableJobs
    .filter((j) => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
      if (defectFilter === "defects-only" && (!j.defects || j.defects.length === 0))
        return false;
      if (defectFilter === "clean" && j.defects && j.defects.length > 0) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          j.jobTitle.toLowerCase().includes(q) ||
          j.company.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="max-w-6xl mx-auto py-10 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">
            Applications Dashboard
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            Quantity, quality, and data integrity — all in one place.
          </p>
        </div>
        <div className="text-[11px] text-neutral-300 font-mono">
          {new Date().toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          }
          label="Applications Sent"
          value={totalApplied}
          sub={`${pipelineReady} ready to send`}
          color="indigo"
        />
        <KpiCard
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 15a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.93 4h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 11a16 16 0 0 0 5 5l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 17z"/></svg>
          }
          label="Response Rate"
          value={responseRate > 0 ? `${responseRate}%` : "—"}
          sub={`${totalInterviewing} interviewing · ${totalOffers} offer${totalOffers !== 1 ? "s" : ""}`}
          color="emerald"
          highlight={totalOffers > 0}
        />
        <KpiCard
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          }
          label="Avg Match Score"
          value={avgScore > 0 ? `${avgScore}` : "—"}
          sub="out of 100"
          color="amber"
        />
        <KpiCard
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          }
          label="Defect Rate"
          value={jobsWithDefects.length > 0 ? `${defectRate}%` : "0%"}
          sub={
            errorCount > 0
              ? `${errorCount} critical error${errorCount !== 1 ? "s" : ""} · ${jobsWithDefects.length} job${jobsWithDefects.length !== 1 ? "s" : ""} affected`
              : jobsWithDefects.length > 0
              ? `${jobsWithDefects.length} warning${jobsWithDefects.length !== 1 ? "s" : ""} — review recommended`
              : "No data quality issues"
          }
          color={errorCount > 0 ? "red" : jobsWithDefects.length > 0 ? "amber" : "emerald"}
          alert={errorCount > 0}
        />
      </div>

      {/* Secondary stats bar */}
      <div className="flex items-center gap-6 px-4 py-3 bg-neutral-50 border border-neutral-200 rounded-xl text-[12px] text-neutral-500">
        <StatPill label="In pipeline" value={pipelineJobs.length} />
        <div className="w-px h-4 bg-neutral-200" />
        <StatPill label="Queued" value={pipelineQueued} />
        <div className="w-px h-4 bg-neutral-200" />
        <StatPill label="Processing" value={pipelineProcessing} loading={pipelineProcessing > 0} />
        <div className="w-px h-4 bg-neutral-200" />
        <StatPill label="Total tracked" value={trackableJobs.length} />
        {jobsWithDefects.length > 0 && (
          <>
            <div className="w-px h-4 bg-neutral-200" />
            <button
              onClick={() => setDefectFilter(defectFilter === "defects-only" ? "all" : "defects-only")}
              className={`flex items-center gap-1 font-medium transition-colors ${
                defectFilter === "defects-only"
                  ? "text-red-600"
                  : "text-amber-600 hover:text-red-600"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/></svg>
              {jobsWithDefects.length} with guardrail flags
            </button>
          </>
        )}
      </div>

      {/* Active batch progress */}
      {pipelineProcessing > 0 && (
        <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50/30">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-[13px] font-medium text-indigo-700">
              Processing {pipelineProcessing} job{pipelineProcessing !== 1 ? "s" : ""}…
            </p>
          </div>
          <div className="mt-2 w-full bg-indigo-100 rounded-full h-1 overflow-hidden">
            <div
              className="bg-indigo-500 h-1 rounded-full transition-all duration-500"
              style={{
                width: `${
                  pipelineJobs.length > 0
                    ? ((pipelineJobs.length - pipelineQueued - pipelineProcessing) /
                        pipelineJobs.length) *
                      100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Search job title or company…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[180px] px-3 py-2 text-[13px] border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 placeholder:text-neutral-300"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-[13px] border border-neutral-200 rounded-lg text-neutral-600 focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="matched">Matched</option>
          <option value="applied">Applied</option>
          <option value="interviewing">Interviewing</option>
          <option value="offer">Offer</option>
          <option value="rejected">Rejected</option>
          <option value="skipped">Skipped</option>
          <option value="failed">Failed</option>
        </select>
        <select
          value={defectFilter}
          onChange={(e) => setDefectFilter(e.target.value as typeof defectFilter)}
          className="px-3 py-2 text-[13px] border border-neutral-200 rounded-lg text-neutral-600 focus:outline-none"
        >
          <option value="all">All Data Quality</option>
          <option value="defects-only">⚠ Flagged only</option>
          <option value="clean">✓ Clean only</option>
        </select>
      </div>

      {/* Applications table */}
      {filteredJobs.length === 0 ? (
        <div className="border border-dashed border-neutral-200 rounded-xl py-16 text-center">
          <p className="text-sm text-neutral-400">
            {trackableJobs.length === 0
              ? "No applications tracked yet."
              : "No jobs match your filters."}
          </p>
          <p className="text-[12px] text-neutral-300 mt-1">
            {trackableJobs.length === 0
              ? "Use the Tailor page to tailor your first resume."
              : "Try adjusting your search or filters."}
          </p>
        </div>
      ) : (
        <div className="border border-neutral-200 rounded-xl overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50">
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Job / Company
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Score
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Data Quality
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filteredJobs.map((job) => {
                const hasErrors = job.defects?.some((d) => d.severity === "error");
                const hasWarnings = job.defects && job.defects.length > 0 && !hasErrors;
                const isExpanded = expandedDefect === job.id;

                return (
                  <>
                    <tr
                      key={job.id}
                      className={`transition-colors ${
                        hasErrors
                          ? "bg-red-50/40 hover:bg-red-50"
                          : hasWarnings
                          ? "bg-amber-50/30 hover:bg-amber-50/60"
                          : "hover:bg-neutral-50"
                      }`}
                    >
                      {/* Job + Company */}
                      <td className="px-4 py-3">
                        <p className="font-medium text-neutral-900 max-w-[220px] truncate">
                          {job.jobTitle}
                        </p>
                        <p className="text-[11px] text-neutral-400 mt-0.5">
                          {job.company}
                          {job.source === "pipeline" && (
                            <span className="ml-1.5 px-1 py-0.5 rounded text-[10px] bg-indigo-50 text-indigo-400 font-medium">
                              pipeline
                            </span>
                          )}
                        </p>
                      </td>

                      {/* Match score */}
                      <td className="px-4 py-3">
                        {job.score > 0 ? (
                          <div>
                            <span
                              className={`font-semibold tabular-nums ${
                                job.score >= 70
                                  ? "text-emerald-600"
                                  : job.score >= 55
                                  ? "text-amber-500"
                                  : "text-red-500"
                              }`}
                            >
                              {job.score}
                            </span>
                            <span className="text-[10px] text-neutral-300">/100</span>
                            {job.originalScore > 0 && job.originalScore !== job.score && (
                              <p className="text-[10px] text-neutral-300 mt-0.5">
                                was {job.originalScore}
                                <span className={`ml-0.5 font-medium ${job.score > job.originalScore ? "text-emerald-400" : "text-red-400"}`}>
                                  {job.score > job.originalScore ? `+${job.score - job.originalScore}` : `${job.score - job.originalScore}`}
                                </span>
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-neutral-300">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <StatusBadge
                          status={job.status}
                          jobId={job.id}
                          onUpdate={(id, status) => {
                            // Update application status
                            updateApplicationStatus(id, status as Application["status"]);
                          }}
                        />
                      </td>

                      {/* Data quality / defect column */}
                      <td className="px-4 py-3">
                        {!job.defects ? (
                          <span className="text-[11px] text-neutral-300">not checked</span>
                        ) : job.defects.length === 0 ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                            Clean
                          </span>
                        ) : (
                          <button
                            onClick={() =>
                              setExpandedDefect(isExpanded ? null : job.id)
                            }
                            className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded px-1.5 py-0.5 transition-colors ${
                              hasErrors
                                ? "text-red-600 bg-red-100 hover:bg-red-200"
                                : "text-amber-600 bg-amber-100 hover:bg-amber-200"
                            }`}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/></svg>
                            {job.defects.length} flag{job.defects.length !== 1 ? "s" : ""}
                            {job.sourceYears != null && job.tailoredYears != null && (
                              <span className="text-[10px] opacity-70">
                                · {job.sourceYears}y→{job.tailoredYears}y
                              </span>
                            )}
                          </button>
                        )}
                      </td>

                      {/* Date */}
                      <td className="px-4 py-3 text-neutral-400 tabular-nums text-[12px]">
                        {new Date(job.date).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        {job.jobUrl && (
                          <a
                            href={job.jobUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-indigo-500 hover:text-indigo-700 font-medium"
                          >
                            View ↗
                          </a>
                        )}
                      </td>
                    </tr>

                    {/* Defect detail row (expanded) */}
                    {isExpanded && job.defects && job.defects.length > 0 && (
                      <tr key={`${job.id}-defects`} className="bg-red-50/60">
                        <td colSpan={6} className="px-6 pb-4 pt-2">
                          <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                            Guardrail flags for {job.jobTitle} @ {job.company}
                          </p>
                          <div className="space-y-1.5">
                            {job.defects.map((d, i) => (
                              <div
                                key={i}
                                className={`text-[12px] px-3 py-2 rounded-lg border flex items-start gap-2 ${
                                  d.severity === "error"
                                    ? "bg-red-100 border-red-200 text-red-800"
                                    : "bg-amber-50 border-amber-200 text-amber-800"
                                }`}
                              >
                                <span className="font-bold shrink-0">
                                  {d.severity === "error" ? "✗" : "⚠"}
                                </span>
                                <span>
                                  {d.message}{" "}
                                  <span className="opacity-60 text-[11px]">
                                    (source: {d.sourceValue} · tailored: {d.tailoredValue})
                                  </span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px] text-neutral-400 pt-2">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
          Clean — no guardrail flags
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
          Warning — data discrepancy detected
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
          Error — critical data integrity issue
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

function KpiCard({
  icon,
  label,
  value,
  sub,
  color,
  alert,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub: string;
  color: "indigo" | "emerald" | "amber" | "red";
  alert?: boolean;
  highlight?: boolean;
}) {
  const colors = {
    indigo: "border-indigo-100 bg-indigo-50 text-indigo-600",
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-600",
    amber: "border-amber-100 bg-amber-50 text-amber-600",
    red: "border-red-200 bg-red-50 text-red-600",
  };

  return (
    <div
      className={`rounded-xl p-4 border relative overflow-hidden ${colors[color]} ${
        highlight ? "ring-2 ring-emerald-400 ring-offset-1" : ""
      }`}
    >
      {alert && (
        <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      )}
      <div className="flex items-center gap-2 mb-2 opacity-60">{icon}</div>
      <p className="text-2xl font-bold tabular-nums tracking-tight">{value}</p>
      <p className="text-[11px] font-semibold opacity-80 mt-0.5">{label}</p>
      <p className="text-[10px] opacity-50 mt-1 leading-relaxed">{sub}</p>
    </div>
  );
}

function StatPill({
  label,
  value,
  loading,
}: {
  label: string;
  value: number;
  loading?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {loading && (
        <span className="w-2 h-2 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
      )}
      <span className="font-semibold text-neutral-700">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function StatusBadge({
  status,
  jobId,
  onUpdate,
}: {
  status: string;
  jobId: string;
  onUpdate: (id: string, status: string) => void;
}) {
  const colors: Record<string, string> = {
    matched: "text-neutral-600 bg-neutral-100",
    approved: "text-blue-600 bg-blue-50",
    applied: "text-emerald-600 bg-emerald-50",
    responded: "text-amber-600 bg-amber-50",
    interviewing: "text-purple-600 bg-purple-50",
    rejected: "text-red-500 bg-red-50",
    offer: "text-emerald-700 bg-emerald-100 font-bold",
    skipped: "text-neutral-400 bg-neutral-50",
    ready: "text-indigo-600 bg-indigo-50",
    failed: "text-red-400 bg-red-50",
  };

  return (
    <select
      value={status}
      onChange={(e) => onUpdate(jobId, e.target.value)}
      className={`text-[11px] font-medium px-2 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-300 ${
        colors[status] ?? "text-neutral-500 bg-neutral-100"
      }`}
    >
      {[
        "matched",
        "applied",
        "responded",
        "interviewing",
        "offer",
        "rejected",
        "skipped",
      ].map((s) => (
        <option key={s} value={s}>
          {s.charAt(0).toUpperCase() + s.slice(1)}
        </option>
      ))}
    </select>
  );
}
