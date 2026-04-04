"use client";

import { useState, useEffect } from "react";
import { useAppStore, PipelineJob, Application } from "@/store/useAppStore";

export default function DashboardPage() {
  const { applications, pipelineJobs, updateApplicationStatus, updatePipelineJob, addApplication } =
    useAppStore();

  // Sync completed applications from the Chrome extension (via pipeline-bridge.js)
  useEffect(() => {
    function syncCompleted() {
      try {
        const stored = localStorage.getItem("autoapply-completed-applications");
        if (!stored) return;
        const completed = JSON.parse(stored);
        if (!Array.isArray(completed)) return;

        for (const app of completed) {
          // Check if already tracked in applications or pipelineJobs
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
            // Update pipeline job status to "applied"
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
        // Clear after syncing
        localStorage.removeItem("autoapply-completed-applications");
      } catch (e) {
        console.warn("Dashboard: Error syncing completed applications", e);
      }
    }

    syncCompleted();
    // Also listen for the custom event from the bridge
    window.addEventListener("autoapply-completed-sync", syncCompleted);
    return () => window.removeEventListener("autoapply-completed-sync", syncCompleted);
  }, [applications, pipelineJobs, addApplication, updatePipelineJob]);

  // Merge pipeline jobs (that are applied) with legacy applications
  const allApplied = [
    ...pipelineJobs
      .filter((j) => j.status === "applied")
      .map(
        (j): Application => ({
          id: j.id,
          jobTitle: j.jobTitle,
          company: j.company,
          jobUrl: j.jobUrl,
          status: "applied",
          appliedAt: j.appliedAt ?? j.addedAt,
          resumeVersion: "pipeline",
          matchScore: j.tailoredScore ?? 0,
        })
      ),
    ...applications,
  ];

  // Stats from ALL pipeline jobs (not just applied)
  const pipelineStats = {
    totalInPipeline: pipelineJobs.length,
    queued: pipelineJobs.filter((j) => j.status === "queued").length,
    processing: pipelineJobs.filter(
      (j) => j.status === "analyzing" || j.status === "tailoring"
    ).length,
    ready: pipelineJobs.filter((j) => j.status === "ready").length,
    applied: pipelineJobs.filter((j) => j.status === "applied").length + applications.filter((a) => a.status === "applied").length,
    interviewing: applications.filter((a) => a.status === "interviewing").length,
    offers: applications.filter((a) => a.status === "offer").length,
    avgScore:
      pipelineJobs.filter((j) => j.tailoredScore).length > 0
        ? Math.round(
            pipelineJobs
              .filter((j) => j.tailoredScore)
              .reduce((sum, j) => sum + (j.tailoredScore ?? 0), 0) /
              pipelineJobs.filter((j) => j.tailoredScore).length
          )
        : allApplied.length > 0
        ? Math.round(
            allApplied.reduce((sum, a) => sum + a.matchScore, 0) / allApplied.length
          )
        : 0,
  };

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Combine all trackable items
  const trackableJobs: TrackableJob[] = [
    ...pipelineJobs
      .filter((j) => j.status === "ready" || j.status === "applied" || j.status === "skipped")
      .map((j) => ({
        id: j.id,
        jobTitle: j.jobTitle,
        company: j.company,
        jobUrl: j.jobUrl,
        score: j.tailoredScore ?? 0,
        originalScore: j.originalScore ?? 0,
        status: j.status === "ready" ? ("matched" as const) : j.status === "applied" ? ("applied" as const) : ("skipped" as const),
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
    })),
  ];

  const filteredJobs = trackableJobs
    .filter((j) => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
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
    <div className="max-w-5xl mx-auto py-10 space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Track all your applications and pipeline progress.
        </p>
      </div>

      {/* Top Stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label="In Pipeline"
          value={pipelineStats.totalInPipeline}
          sub={`${pipelineStats.queued} queued · ${pipelineStats.ready} ready`}
          color="bg-indigo-50 border-indigo-100 text-indigo-600"
        />
        <StatCard
          label="Applied"
          value={pipelineStats.applied}
          sub={pipelineStats.processing > 0 ? `${pipelineStats.processing} processing...` : "total applications"}
          color="bg-emerald-50 border-emerald-100 text-emerald-600"
        />
        <StatCard
          label="Interviewing"
          value={pipelineStats.interviewing}
          sub={pipelineStats.offers > 0 ? `${pipelineStats.offers} offers!` : "in progress"}
          color="bg-violet-50 border-violet-100 text-violet-600"
        />
        <StatCard
          label="Avg Score"
          value={pipelineStats.avgScore > 0 ? `${pipelineStats.avgScore}%` : "—"}
          sub="match quality"
          color="bg-amber-50 border-amber-100 text-amber-600"
        />
      </div>

      {/* Pipeline Progress (if batch is active) */}
      {pipelineStats.processing > 0 && (
        <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50/30">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-[13px] font-medium text-indigo-700">
              Processing {pipelineStats.processing} jobs...
            </p>
          </div>
          <div className="mt-3 w-full bg-indigo-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-indigo-600 h-1.5 rounded-full transition-all duration-500"
              style={{
                width: `${
                  pipelineStats.totalInPipeline > 0
                    ? ((pipelineStats.totalInPipeline -
                        pipelineStats.queued -
                        pipelineStats.processing) /
                        pipelineStats.totalInPipeline) *
                      100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search jobs or companies..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 text-[13px] border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 placeholder:text-neutral-300"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-[13px] border border-neutral-200 rounded-lg text-neutral-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          <option value="all">All Statuses</option>
          <option value="matched">Matched</option>
          <option value="applied">Applied</option>
          <option value="interviewing">Interviewing</option>
          <option value="offer">Offer</option>
          <option value="rejected">Rejected</option>
          <option value="skipped">Skipped</option>
        </select>
      </div>

      {/* Applications Table */}
      {filteredJobs.length === 0 ? (
        <div className="border border-dashed border-neutral-200 rounded-xl py-16 text-center">
          <p className="text-sm text-neutral-400">
            {trackableJobs.length === 0
              ? "No applications yet."
              : "No jobs match your filters."}
          </p>
          <p className="text-[12px] text-neutral-300 mt-1">
            {trackableJobs.length === 0
              ? "Use the Pipeline to batch-tailor and apply."
              : "Try adjusting your search or status filter."}
          </p>
        </div>
      ) : (
        <div className="border border-neutral-200 rounded-xl overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50">
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                  Job
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                  Company
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                  Score
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filteredJobs.map((job) => (
                <tr key={job.id} className="hover:bg-neutral-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-neutral-900 max-w-[200px] truncate">
                    {job.jobTitle}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">{job.company}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`font-medium tabular-nums ${
                        job.score >= 70
                          ? "text-emerald-600"
                          : job.score >= 55
                          ? "text-amber-500"
                          : "text-red-500"
                      }`}
                    >
                      {job.score}
                    </span>
                    {job.originalScore > 0 && job.originalScore !== job.score && (
                      <span className="text-[10px] text-neutral-300 ml-1">
                        (was {job.originalScore})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-4 py-3 text-neutral-400 tabular-nums">
                    {new Date(job.date).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {job.jobUrl && (
                        <a
                          href={job.jobUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-indigo-500 hover:text-indigo-600 font-medium"
                        >
                          View Job
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────── HELPERS ──────────────────────────── */

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
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number | string;
  sub: string;
  color: string;
}) {
  return (
    <div className={`rounded-xl p-4 border ${color}`}>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="text-[11px] font-medium opacity-80 mt-0.5">{label}</p>
      <p className="text-[10px] opacity-50 mt-1">{sub}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    matched: "text-neutral-600 bg-neutral-100",
    approved: "text-blue-600 bg-blue-50",
    applied: "text-emerald-600 bg-emerald-50",
    responded: "text-amber-600 bg-amber-50",
    interviewing: "text-purple-600 bg-purple-50",
    rejected: "text-red-500 bg-red-50",
    offer: "text-emerald-700 bg-emerald-100",
    skipped: "text-neutral-400 bg-neutral-50",
    ready: "text-indigo-600 bg-indigo-50",
  };

  return (
    <span
      className={`text-[11px] font-medium px-2 py-1 rounded-full ${
        colors[status] ?? "text-neutral-500 bg-neutral-100"
      }`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
