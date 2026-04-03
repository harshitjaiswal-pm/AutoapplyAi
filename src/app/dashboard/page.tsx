"use client";

import { useAppStore, Application } from "@/store/useAppStore";

/**
 * DASHBOARD PAGE — Application tracker at "/dashboard"
 *
 * Shows all jobs you've tailored resumes for, with their match scores
 * and current status in the application funnel.
 *
 * For MVP, data is stored in memory (Zustand store).
 * In Phase 2, this connects to Supabase for persistence.
 */
export default function DashboardPage() {
  const { applications, updateApplicationStatus } = useAppStore();

  // Stats for the overview cards
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
    <div className="max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-navy">Application Dashboard</h1>
        <p className="mt-2 text-gray-600">
          Track every job you&apos;ve applied to in one place.
        </p>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Jobs" value={stats.total} color="blue" />
        <StatCard label="Applied" value={stats.applied} color="green" />
        <StatCard label="Interviewing" value={stats.interviewing} color="purple" />
        <StatCard label="Avg Match" value={`${stats.avgScore}%`} color="orange" />
      </div>

      {/* Applications Table */}
      {applications.length === 0 ? (
        <div className="bg-white rounded-xl p-12 text-center border border-gray-100">
          <p className="text-gray-500 text-lg">No applications yet.</p>
          <p className="text-gray-400 text-sm mt-2">
            Go to the Tailor page and create your first tailored resume!
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-600">Job</th>
                <th className="px-4 py-3 font-medium text-gray-600">Company</th>
                <th className="px-4 py-3 font-medium text-gray-600">Score</th>
                <th className="px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 font-medium text-gray-600">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {applications.map((app) => (
                <tr key={app.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {app.jobTitle}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{app.company}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`font-semibold ${
                        app.matchScore >= 80
                          ? "text-green-600"
                          : app.matchScore >= 60
                          ? "text-yellow-600"
                          : "text-red-600"
                      }`}
                    >
                      {app.matchScore}%
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusSelector
                      application={app}
                      onChange={(status) =>
                        updateApplicationStatus(app.id, status)
                      }
                    />
                  </td>
                  <td className="px-4 py-3 text-gray-500">
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

/** Stat card for the overview section */
function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    green: "bg-green-50 text-green-700 border-green-200",
    purple: "bg-purple-50 text-purple-700 border-purple-200",
    orange: "bg-orange-50 text-orange-700 border-orange-200",
  };

  return (
    <div className={`rounded-xl p-4 border ${colorMap[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-sm opacity-75">{label}</p>
    </div>
  );
}

/** Dropdown to change application status */
function StatusSelector({
  application,
  onChange,
}: {
  application: Application;
  onChange: (status: Application["status"]) => void;
}) {
  const statusColors: Record<Application["status"], string> = {
    matched: "bg-gray-100 text-gray-700",
    approved: "bg-blue-100 text-blue-700",
    applied: "bg-green-100 text-green-700",
    responded: "bg-yellow-100 text-yellow-700",
    interviewing: "bg-purple-100 text-purple-700",
    rejected: "bg-red-100 text-red-700",
    offer: "bg-emerald-100 text-emerald-700",
  };

  return (
    <select
      value={application.status}
      onChange={(e) => onChange(e.target.value as Application["status"])}
      className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer ${
        statusColors[application.status]
      }`}
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
