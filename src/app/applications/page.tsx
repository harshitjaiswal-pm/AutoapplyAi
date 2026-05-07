"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SubmissionRecord } from "@/lib/submissions";

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

const STATUS_STYLES: Record<SubmissionRecord["status"], string> = {
  in_progress: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

const STATUS_LABEL: Record<SubmissionRecord["status"], string> = {
  in_progress: "Running",
  completed: "Submitted",
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
    ? {
        all: submissions.length,
        running: submissions.filter((s) => s.status === "in_progress").length,
        submitted: submissions.filter((s) => s.status === "completed").length,
        failed: submissions.filter((s) => s.status === "failed").length,
      }
    : null;

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl font-bold">Submissions</h1>
          <p className="text-indigo-300 text-sm mt-1">
            Every Workday application your worker has run, written from any
            laptop you sign into. Auto-refreshes every 10s.
          </p>
          {counts && (
            <div className="grid grid-cols-4 gap-3 mt-6">
              {[
                { label: "All", value: counts.all, accent: "text-white" },
                { label: "Running", value: counts.running, accent: counts.running > 0 ? "text-blue-300" : "text-indigo-200" },
                { label: "Submitted", value: counts.submitted, accent: counts.submitted > 0 ? "text-emerald-300" : "text-indigo-200" },
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
              Run <code className="bg-neutral-100 px-1.5 py-0.5 rounded">smoke_full_apply.ts</code> on your
              laptop with a Workday URL. It writes here as it runs.
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
                  <th className="text-left px-3 py-3 font-semibold">Steps</th>
                  <th className="text-left px-5 py-3 font-semibold">Shots</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {submissions.map((s) => (
                  <tr
                    key={s.applicationId}
                    onClick={() => router.push(`/applications/${s.applicationId}`)}
                    className="hover:bg-indigo-50/50 cursor-pointer transition-colors"
                  >
                    <td className="px-5 py-3">
                      <p className="font-medium text-neutral-900">{s.company}</p>
                      {s.tenant && (
                        <p className="text-[10px] text-neutral-400 mt-0.5">{s.tenant}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 max-w-[280px]">
                      <p className="text-neutral-700 truncate">{s.jobTitle}</p>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[s.status] ?? "bg-neutral-100 text-neutral-500"}`}>
                        {STATUS_LABEL[s.status] ?? s.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {s.matchScore != null ? (
                        <span className={`text-xs font-bold tabular-nums ${
                          s.matchScore >= 80 ? "text-emerald-600" :
                          s.matchScore >= 60 ? "text-amber-600" :
                          "text-neutral-400"
                        }`}>
                          {s.matchScore}
                          {s.originalMatchScore != null && s.matchScore > s.originalMatchScore && (
                            <span className="text-[10px] text-emerald-500 font-normal ml-1">
                              +{s.matchScore - s.originalMatchScore}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-neutral-500 whitespace-nowrap">{formatRelativeDate(s.startedAt)}</td>
                    <td className="px-3 py-3 text-neutral-500 whitespace-nowrap tabular-nums">{formatDuration(s.startedAt, s.completedAt)}</td>
                    <td className="px-3 py-3 text-neutral-500 tabular-nums">{s.steps?.length ?? 0}</td>
                    <td className="px-5 py-3 text-neutral-500 tabular-nums">{s.screenshots?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
