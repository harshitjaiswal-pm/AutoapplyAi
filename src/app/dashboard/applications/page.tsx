"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ApplicationSummary {
  applicationId: string;
  jobTitle: string;
  company: string;
  jobUrl?: string;
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "failed"
    | "submitted_stubbed";
  stepCount: number;
  failedStepCount: number;
  totalCostCents: number;
  totalDurationMs: number;
  createdAt: string;
  updatedAt: string;
}

const STATUS_STYLES: Record<ApplicationSummary["status"], string> = {
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  in_progress: "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-300",
  failed: "bg-rose-100 text-rose-800 border-rose-300",
  submitted_stubbed: "bg-violet-100 text-violet-800 border-violet-300",
};

function fmtCost(c: number) {
  return c < 100 ? `${c.toFixed(1)}¢` : `$${(c / 100).toFixed(2)}`;
}
function fmtDur(ms: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
function fmtAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ApplicationsPage() {
  const [apps, setApps] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/applications")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        setApps(d.applications ?? []);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Applications</h1>
        <p className="mt-4 text-rose-700">Error loading applications: {error}</p>
      </div>
    );
  }
  if (apps === null) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Applications</h1>
        <p className="mt-4 text-slate-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Applications</h1>
          <p className="text-sm text-slate-500 mt-1">
            Worker-driven application queue. Click any row to review what was
            filled and approve.
          </p>
        </div>
        <span className="text-sm text-slate-500">{apps.length} total</span>
      </header>

      {apps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-12 text-center">
          <p className="text-slate-600">No worker-driven applications yet.</p>
          <p className="text-sm text-slate-500 mt-2">
            When the worker enqueues an application, it will show up here with
            its full step trace, tailored resume, and an Approve button.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium text-slate-700">Job</th>
                <th className="px-4 py-2 font-medium text-slate-700">Status</th>
                <th className="px-4 py-2 font-medium text-slate-700">Steps</th>
                <th className="px-4 py-2 font-medium text-slate-700">Cost</th>
                <th className="px-4 py-2 font-medium text-slate-700">Duration</th>
                <th className="px-4 py-2 font-medium text-slate-700">Updated</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr
                  key={a.applicationId}
                  className="border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/applications/${a.applicationId}`}
                      className="text-blue-700 hover:underline"
                    >
                      {a.jobTitle}
                    </Link>
                    <div className="text-xs text-slate-500">{a.company}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[a.status]}`}
                    >
                      {a.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {a.stepCount}
                    {a.failedStepCount > 0 && (
                      <span className="ml-1 text-rose-700">
                        ({a.failedStepCount} failed)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {fmtCost(a.totalCostCents)}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {fmtDur(a.totalDurationMs)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {fmtAgo(a.updatedAt)}
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
