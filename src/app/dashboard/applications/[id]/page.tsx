"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface AuditStep {
  stepName: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  costCents?: number;
  output?: Record<string, unknown>;
  error?: string;
  artifactUrl?: string;
}

interface Application {
  applicationId: string;
  queueJobId?: string;
  userId: string;
  jobMeta: { jobUrl?: string; jobTitle?: string; company?: string };
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "failed"
    | "submitted_stubbed";
  steps: AuditStep[];
  totalCostCents: number;
  totalDurationMs: number;
  createdAt: string;
  updatedAt: string;
  qa?: Array<{ label: string; value: string; source?: string; flagged?: boolean }>;
  tailoredResumeUrl?: string;
}

const STATUS_STYLES: Record<Application["status"], string> = {
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  in_progress: "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-300",
  failed: "bg-rose-100 text-rose-800 border-rose-300",
  submitted_stubbed: "bg-violet-100 text-violet-800 border-violet-300",
};

function fmtCost(c?: number) {
  if (c === undefined || c === null) return "—";
  return c < 100 ? `${c.toFixed(2)}¢` : `$${(c / 100).toFixed(2)}`;
}
function fmtDur(ms?: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

export default function ApplicationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [app, setApp] = useState<Application | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/applications/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        setApp(d.application);
      })
      .catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const onApprove = async () => {
    if (!app) return;
    if (
      !confirm(
        "Approve & Submit (stubbed) — this will mark the application as submitted but will NOT actually click Submit on the live ATS. The real submit handoff is v2. OK to proceed?"
      )
    )
      return;
    setApproving(true);
    try {
      const r = await fetch(`/api/applications/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_stub" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      load();
    } catch (e) {
      alert(`Approve failed: ${e}`);
    } finally {
      setApproving(false);
    }
  };

  if (error) {
    return (
      <div className="p-8">
        <Link href="/dashboard/applications" className="text-blue-700 hover:underline">
          ← Back to applications
        </Link>
        <p className="mt-4 text-rose-700">Error: {error}</p>
      </div>
    );
  }
  if (!app) {
    return <div className="p-8 text-slate-500">Loading…</div>;
  }

  const tailorStep = app.steps.find((s) => s.stepName === "tailor_resume");
  const failedSteps = app.steps.filter((s) => s.status === "failed");

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <Link
        href="/dashboard/applications"
        className="text-sm text-blue-700 hover:underline"
      >
        ← Back to applications
      </Link>
      <header className="mt-2 mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{app.jobMeta.jobTitle}</h1>
          <p className="text-slate-600 mt-1">
            {app.jobMeta.company}
            {app.jobMeta.jobUrl && (
              <>
                {" · "}
                <a
                  href={app.jobMeta.jobUrl}
                  target="_blank"
                  className="text-blue-700 hover:underline"
                  rel="noopener"
                >
                  Original posting ↗
                </a>
              </>
            )}
          </p>
          <div className="mt-3 flex items-center gap-3 text-sm">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[app.status]}`}
            >
              {app.status.replace("_", " ")}
            </span>
            <span className="text-slate-600">
              {app.steps.length} steps · {fmtCost(app.totalCostCents)} ·{" "}
              {fmtDur(app.totalDurationMs)}
            </span>
          </div>
        </div>
        <button
          onClick={onApprove}
          disabled={approving || app.status === "submitted_stubbed"}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {app.status === "submitted_stubbed"
            ? "Submitted (stub) ✓"
            : approving
            ? "Approving…"
            : "Approve & Submit (stubbed)"}
        </button>
      </header>

      {/* Tailored resume preview */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-2">Tailored Resume</h2>
        {app.tailoredResumeUrl ? (
          <iframe
            src={app.tailoredResumeUrl}
            className="w-full h-[600px] rounded border border-slate-200"
            title="Tailored resume preview"
          />
        ) : tailorStep?.artifactUrl ? (
          <div className="rounded border border-slate-200 p-4 text-sm">
            <p className="text-slate-600">
              Tailored resume artifact:{" "}
              <code className="font-mono text-xs">{tailorStep.artifactUrl}</code>
            </p>
            <p className="text-xs text-slate-500 mt-2">
              (DOCX rendering proxy not yet wired — Step 4 of the loop. The R2
              JSON contains the structured tailored content.)
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No tailored resume yet.</p>
        )}
      </section>

      {/* Q&A */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-2">Application Q&A</h2>
        {app.qa && app.qa.length > 0 ? (
          <div className="overflow-hidden rounded border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Question</th>
                  <th className="px-3 py-2 font-medium">Answer</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {app.qa.map((q, i) => (
                  <tr
                    key={i}
                    className={`border-b border-slate-100 ${q.flagged ? "bg-amber-50" : ""}`}
                  >
                    <td className="px-3 py-2">
                      {q.flagged && (
                        <span className="inline-block bg-amber-100 text-amber-800 rounded px-1 py-0.5 text-xs mr-2">
                          ⚑
                        </span>
                      )}
                      {q.label}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{q.value}</td>
                    <td className="px-3 py-2 text-slate-500 text-xs">
                      {q.source ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No Q&A captured yet. (Step 3 — wizard walker — will populate this.)
          </p>
        )}
      </section>

      {/* Step trace */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-2">Step Trace</h2>
        {failedSteps.length > 0 && (
          <div className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {failedSteps.length} step{failedSteps.length === 1 ? "" : "s"} failed.
            Review below for the error and screenshot.
          </div>
        )}
        <div className="space-y-3">
          {app.steps.map((s, i) => (
            <div
              key={i}
              className={`rounded border px-3 py-2 ${
                s.status === "failed"
                  ? "border-rose-200 bg-rose-50"
                  : s.status === "completed"
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-slate-200 bg-slate-50"
              }`}
            >
              <div className="flex items-center justify-between text-sm">
                <span className="font-mono">
                  #{i + 1} {s.stepName}
                </span>
                <span className="text-slate-600 text-xs">
                  {fmtDur(s.durationMs)} · {fmtCost(s.costCents)}
                </span>
              </div>
              {s.error && (
                <p className="mt-1 text-xs text-rose-800 font-mono">
                  {s.error}
                </p>
              )}
              {s.output != null && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-slate-600">
                    output
                  </summary>
                  <pre className="mt-1 text-xs font-mono text-slate-700 overflow-x-auto">
                    {JSON.stringify(s.output, null, 2)}
                  </pre>
                </details>
              )}
              {s.artifactUrl && s.artifactUrl.match(/\.(png|jpe?g|gif|webp)$/i) && (
                <img
                  src={s.artifactUrl}
                  alt={`${s.stepName} screenshot`}
                  className="mt-2 max-h-72 rounded border border-slate-200"
                />
              )}
              {s.artifactUrl && !s.artifactUrl.match(/\.(png|jpe?g|gif|webp)$/i) && (
                <p className="mt-1 text-xs text-slate-500">
                  artifact:{" "}
                  <code className="font-mono">{s.artifactUrl}</code>
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <footer className="text-xs text-slate-500">
        Created {new Date(app.createdAt).toLocaleString()} · Updated{" "}
        {new Date(app.updatedAt).toLocaleString()} · ID{" "}
        <code className="font-mono">{app.applicationId}</code>
      </footer>
    </div>
  );
}
