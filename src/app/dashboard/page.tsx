"use client";

import { useAppStore, Application } from "@/store/useAppStore";

export default function DashboardPage() {
  const { applications, updateApplicationStatus } = useAppStore();

  const stats = {
    total: applications.length,
    applied: applications.filter((a) => a.status === "applied").length,
    interviewing: applications.filter((a) => a.status === "interviewing").length,
    avgScore:
      applications.length > 0
        ? Math.round(
            applications.reduce((sum, a) => sum + a.matchScore, 0) /
              applications.length
          )
        : 0,
  };

  return (
    <div className="max-w-4xl mx-auto py-12 space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Track your applications in one place.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Stat label="Total" value={stats.total} color="bg-indigo-50 border-indigo-100 text-indigo-600" />
        <Stat label="Applied" value={stats.applied} color="bg-emerald-50 border-emerald-100 text-emerald-600" />
        <Stat label="Interviewing" value={stats.interviewing} color="bg-violet-50 border-violet-100 text-violet-600" />
        <Stat label="Avg match" value={`${stats.avgScore}%`} color="bg-amber-50 border-amber-100 text-amber-600" />
      </div>

      {/* Table */}
      {applications.length === 0 ? (
        <div className="border border-neutral-200 rounded-xl py-20 text-center">
          <p className="text-sm text-neutral-400">No applications yet.</p>
          <p className="text-[13px] text-neutral-300 mt-1">
            Tailor a resume to see it here.
          </p>
        </div>
      ) : (
        <div className="border border-neutral-200 rounded-xl overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50">
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">Job</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">Company</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">Score</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-400 uppercase tracking-wider">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {applications.map((app) => (
                <tr key={app.id} className="hover:bg-neutral-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-neutral-900">{app.jobTitle}</td>
                  <td className="px-4 py-3 text-neutral-500">{app.company}</td>
                  <td className="px-4 py-3">
                    <span className={`font-medium tabular-nums ${
                      app.matchScore >= 70 ? "text-emerald-600"
                        : app.matchScore >= 55 ? "text-amber-500"
                        : "text-red-500"
                    }`}>
                      {app.matchScore}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusSelect app={app} onChange={(s) => updateApplicationStatus(app.id, s)} />
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {new Date(app.appliedAt).toLocaleDateString()}
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

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className={`rounded-xl p-5 text-center border ${color}`}>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="text-[11px] opacity-60 mt-0.5 uppercase tracking-wider">{label}</p>
    </div>
  );
}

function StatusSelect({
  app,
  onChange,
}: {
  app: Application;
  onChange: (status: Application["status"]) => void;
}) {
  const colors: Record<Application["status"], string> = {
    matched: "text-neutral-600 bg-neutral-100",
    approved: "text-blue-600 bg-blue-50",
    applied: "text-emerald-600 bg-emerald-50",
    responded: "text-amber-600 bg-amber-50",
    interviewing: "text-purple-600 bg-purple-50",
    rejected: "text-red-500 bg-red-50",
    offer: "text-emerald-700 bg-emerald-50",
  };

  return (
    <select
      value={app.status}
      onChange={(e) => onChange(e.target.value as Application["status"])}
      className={`text-[12px] font-medium px-2 py-1 rounded-md border-0 cursor-pointer ${colors[app.status]} focus:outline-none focus:ring-1 focus:ring-neutral-300`}
    >
      <option value="matched">Matched</option>
      <option value="approved">Approved</option>
      <option value="applied">Applied</option>
      <option value="responded">Responded</option>
      <option value="interviewing">Interviewing</option>
      <option value="rejected">Rejected</option>
      <option value="offer">Offer</option>
    </select>
  );
}
