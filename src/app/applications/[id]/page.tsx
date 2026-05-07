"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { SubmissionRecord } from "@/lib/submissions";
import { CopyButton } from "@/components/CopyButton";
import { TailoredResumeView } from "@/components/TailoredResumeView";

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

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export default function SubmissionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [submission, setSubmission] = useState<SubmissionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomedShot, setZoomedShot] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/applications/${id}`);
        if (!res.ok) {
          setError(res.status === 404 ? "Submission not found." : `Failed to load: ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setSubmission(data.submission);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 8_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link href="/applications" className="text-xs text-indigo-600 hover:text-indigo-700">← All submissions</Link>
        <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">{error}</div>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-center text-neutral-400 text-sm">Loading…</div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <Link href="/applications" className="text-xs text-indigo-300 hover:text-white">← All submissions</Link>
          <div className="flex items-start justify-between gap-4 mt-2">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold truncate">{submission.jobTitle}</h1>
              <p className="text-indigo-300 text-sm mt-1">
                {submission.company}
                {submission.tenant && <> · <span className="text-indigo-400">{submission.tenant}</span></>}
              </p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-2">
              <span className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${STATUS_STYLES[submission.status] ?? "bg-neutral-100 text-neutral-500"}`}>
                {STATUS_LABEL[submission.status] ?? submission.status}
              </span>
              {submission.matchScore != null && (
                <div className="text-right">
                  <span className={`text-2xl font-bold tabular-nums ${
                    submission.matchScore >= 80 ? "text-emerald-300" :
                    submission.matchScore >= 60 ? "text-amber-300" : "text-indigo-200"
                  }`}>
                    {submission.matchScore}
                  </span>
                  <span className="text-xs text-indigo-300 ml-1">/100 match</span>
                  {submission.originalMatchScore != null && submission.matchScore > submission.originalMatchScore && (
                    <p className="text-[10px] text-emerald-300 mt-0.5">
                      +{submission.matchScore - submission.originalMatchScore} from {submission.originalMatchScore} after tailoring
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 text-xs">
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Started</p>
              <p className="mt-0.5">{fmtDate(submission.startedAt)}</p>
              <p className="text-indigo-300">{fmtTime(submission.startedAt)}</p>
            </div>
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Finished</p>
              <p className="mt-0.5">{submission.completedAt ? fmtDate(submission.completedAt) : "—"}</p>
              <p className="text-indigo-300">{fmtTime(submission.completedAt)}</p>
            </div>
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Source</p>
              <p className="mt-0.5">{submission.source}</p>
            </div>
            <div>
              <p className="text-indigo-400 uppercase tracking-wider text-[10px] font-semibold">Job URL</p>
              <a href={submission.jobUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-200 hover:text-white text-[10px] underline block truncate">
                Open ↗
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {submission.errorMessage && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-red-700 uppercase tracking-wider">Error</p>
            <p className="text-sm text-red-700 mt-1 whitespace-pre-wrap font-mono">{submission.errorMessage}</p>
          </div>
        )}

        {/* Tailored resume — full inline preview, no need to download to read it */}
        {(submission.tailoredResumeJson || submission.resumeUrl) && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-neutral-900">Tailored Resume</h2>
              <div className="flex items-center gap-2">
                {submission.tailoringCostCents != null && (
                  <span className="text-[11px] text-neutral-400">{submission.tailoringCostCents.toFixed(1)}¢ to tailor</span>
                )}
                {submission.resumeUrl && (
                  <a
                    href={submission.resumeUrl}
                    download={submission.resumeFilename || "tailored-resume.docx"}
                    className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  >
                    ↓ Download .docx
                  </a>
                )}
              </div>
            </div>
            {submission.tailoredResumeJson ? (
              <TailoredResumeView resume={submission.tailoredResumeJson} />
            ) : (
              <p className="text-xs text-neutral-400">
                Inline preview not available for this submission (run was before
                the worker started capturing the structured resume). Use the
                Download button above to view the .docx.
              </p>
            )}
          </div>
        )}

        {/* Cover letter — full text, copyable */}
        {submission.coverLetter && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-neutral-900">Cover Letter</h2>
              <CopyButton text={submission.coverLetter} label="Copy cover letter" />
            </div>
            <div className="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed select-text">
              {submission.coverLetter}
            </div>
          </div>
        )}

        {/* What Claude changed */}
        {submission.tailoringChanges && submission.tailoringChanges.length > 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <h2 className="text-sm font-semibold text-neutral-900 mb-3">
              Changes Claude made ({submission.tailoringChanges.length})
            </h2>
            <ul className="space-y-2">
              {submission.tailoringChanges.map((c, i) => (
                <li key={i} className="text-xs text-neutral-600 select-text">
                  <span className="inline-block bg-indigo-50 text-indigo-700 text-[10px] font-medium px-1.5 py-0.5 rounded mr-1.5">
                    {c.category}
                  </span>
                  {c.text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Screenshots */}
        <div className="bg-white rounded-2xl border border-neutral-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-neutral-900">Evidence Screenshots</h2>
            <span className="text-xs text-neutral-400">{submission.screenshots?.length ?? 0} captured</span>
          </div>

          {(!submission.screenshots || submission.screenshots.length === 0) ? (
            <div className="text-center py-12">
              <p className="text-sm text-neutral-400">
                {submission.status === "in_progress"
                  ? "Screenshots will appear as the worker walks the wizard…"
                  : "No screenshots were captured for this submission."}
              </p>
              {!submission.screenshots?.length && submission.status !== "in_progress" && (
                <p className="text-[11px] text-neutral-300 mt-2">
                  (Worker may not have BLOB_READ_WRITE_TOKEN configured — check the dev terminal for [submissions] warnings.)
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {submission.screenshots.map((shot, i) => (
                <button
                  key={`${shot.step}-${i}`}
                  onClick={() => setZoomedShot(shot.url)}
                  className="text-left group"
                >
                  <div className="aspect-[4/3] bg-neutral-100 rounded-lg border border-neutral-200 overflow-hidden group-hover:border-indigo-300 transition-colors">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={shot.url} alt={shot.step} className="w-full h-full object-cover object-top" />
                  </div>
                  <p className="text-xs font-medium text-neutral-700 mt-2 truncate">{shot.step}</p>
                  {shot.pageHeader && (
                    <p className="text-[11px] text-neutral-400 truncate">{shot.pageHeader}</p>
                  )}
                  <p className="text-[10px] text-neutral-300 mt-0.5">{fmtTime(shot.capturedAt)}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Steps */}
        {submission.steps?.length > 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <h2 className="text-sm font-semibold text-neutral-900 mb-3">Step Log</h2>
            <ol className="space-y-3">
              {submission.steps.map((step, i) => (
                <li key={i} className="flex items-start gap-3 text-xs">
                  <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                    step.status === "completed" ? "bg-emerald-500"
                      : step.status === "failed" ? "bg-red-500"
                      : step.status === "running" ? "bg-blue-500 animate-pulse"
                      : "bg-neutral-300"
                  }`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-neutral-800 font-medium select-text">{step.name}</p>
                      {(step.note || step.error) && (
                        <CopyButton text={[step.name, step.note, step.error].filter(Boolean).join("\n")} />
                      )}
                    </div>
                    {step.note && <p className="text-neutral-600 mt-1 leading-relaxed select-text">{step.note}</p>}
                    {step.error && <p className="text-red-600 mt-1 font-mono select-text whitespace-pre-wrap">{step.error}</p>}
                  </div>
                  <span className="text-neutral-300 shrink-0 tabular-nums">
                    {step.durationMs != null ? `${(step.durationMs / 1000).toFixed(1)}s` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {/* Zoomed screenshot modal */}
      {zoomedShot && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setZoomedShot(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomedShot} alt="Zoomed screenshot" className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}
