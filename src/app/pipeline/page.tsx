"use client";

import { useState, useRef, useCallback, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  useAppStore,
  PipelineJob,
  PipelineStatus,
  BatchRun,
  ParsedResume,
} from "@/store/useAppStore";
import { runBatch, generateJobId } from "@/lib/batchProcessor";

export default function PipelinePageWrapper() {
  return (
    <Suspense fallback={<div className="max-w-5xl mx-auto py-10 text-center text-neutral-400">Loading pipeline...</div>}>
      <PipelinePage />
    </Suspense>
  );
}

function PipelinePage() {
  const {
    pipelineJobs,
    pipelineResumeText,
    pipelineParsedResume,
    currentBatch,
    addPipelineJob,
    addPipelineJobs,
    updatePipelineJob,
    removePipelineJob,
    clearPipelineJobs,
    setPipelineResumeText,
    setPipelineParsedResume,
    setCurrentBatch,
    updateCurrentBatch,
  } = useAppStore();

  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<"add" | "queue" | "results">("add");
  const [mode, setMode] = useState<"fast" | "pro">("fast");

  // Helper to import jobs from any source
  const importJobs = useCallback((incoming: any[]) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    const newJobs: PipelineJob[] = incoming.map((j: any) => ({
      id: generateJobId(),
      jobTitle: j.jobTitle || "Untitled",
      company: j.company || "Unknown",
      location: j.location || "",
      jobUrl: j.jobUrl || "",
      jobDescription: j.jobDescription || "",
      source: (j.source as any) || "linkedin",
      easyApply: j.easyApply ?? false,
      status: "queued" as const,
      addedAt: new Date().toISOString(),
    }));
    addPipelineJobs(newJobs);
    setActiveTab("queue");
  }, [addPipelineJobs]);

  // Method 1: Handle jobs from URL params (small payloads)
  useEffect(() => {
    const jobsParam = searchParams.get("jobs");
    if (jobsParam) {
      try {
        const incoming = JSON.parse(jobsParam);
        importJobs(incoming);
        window.history.replaceState({}, "", "/pipeline");
      } catch (e) {
        console.error("Failed to parse jobs from URL:", e);
      }
    }
  }, [searchParams, importJobs]);

  // Method 2: Handle jobs injected by Chrome Extension via localStorage + custom event
  useEffect(() => {
    // Check localStorage on mount (extension may have already injected data)
    const stored = localStorage.getItem("autoapply-extension-jobs");
    if (stored) {
      try {
        const incoming = JSON.parse(stored);
        importJobs(incoming);
        localStorage.removeItem("autoapply-extension-jobs");
        window.history.replaceState({}, "", "/pipeline");
      } catch (e) {
        console.error("Failed to parse jobs from localStorage:", e);
      }
    }

    // Also listen for the custom event (if extension injects after page load)
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.jobs) {
        importJobs(detail.jobs);
        localStorage.removeItem("autoapply-extension-jobs");
        window.history.replaceState({}, "", "/pipeline");
      }
    };

    window.addEventListener("autoapply-extension-import", handler);
    return () => window.removeEventListener("autoapply-extension-import", handler);
  }, [importJobs]);

  return (
    <div className="max-w-5xl mx-auto py-10 space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">
          Auto-Apply Pipeline
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Add jobs, batch-tailor resumes, and track applications.
        </p>
      </div>

      {/* Pipeline Stats Bar */}
      <PipelineStats jobs={pipelineJobs} batch={currentBatch} />

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-neutral-200">
        {(["add", "queue", "results"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-neutral-400 hover:text-neutral-600"
            }`}
          >
            {tab === "add" && `Add Jobs`}
            {tab === "queue" && `Queue (${pipelineJobs.filter((j) => j.status === "queued").length})`}
            {tab === "results" && `Results (${pipelineJobs.filter((j) => j.status === "ready" || j.status === "applied").length})`}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "add" && (
        <AddJobsTab
          resumeText={pipelineResumeText}
          parsedResume={pipelineParsedResume}
          onResumeUpload={setPipelineResumeText}
          onResumeParsed={setPipelineParsedResume}
          onJobsAdded={(jobs) => {
            addPipelineJobs(jobs);
            setActiveTab("queue");
          }}
        />
      )}

      {activeTab === "queue" && (
        <QueueTab
          jobs={pipelineJobs}
          parsedResume={pipelineParsedResume}
          mode={mode}
          onModeChange={setMode}
          currentBatch={currentBatch}
          onRemoveJob={removePipelineJob}
          onClearAll={clearPipelineJobs}
          onStartBatch={() => {
            if (!pipelineParsedResume) return;
            const batchId = `batch_${Date.now()}`;
            const queuedCount = pipelineJobs.filter((j) => j.status === "queued").length;
            setCurrentBatch({
              id: batchId,
              startedAt: new Date().toISOString(),
              totalJobs: queuedCount,
              processed: 0,
              succeeded: 0,
              failed: 0,
              isRunning: true,
            });

            runBatch(pipelineJobs, pipelineParsedResume, mode, {
              onJobStart: () => {},
              onJobAnalyzed: () => {},
              onJobComplete: (jobId, orig, tailored) => {
                updateCurrentBatch({
                  processed: (useAppStore.getState().currentBatch?.processed ?? 0) + 1,
                  succeeded: (useAppStore.getState().currentBatch?.succeeded ?? 0) + 1,
                });
              },
              onJobFailed: () => {
                updateCurrentBatch({
                  processed: (useAppStore.getState().currentBatch?.processed ?? 0) + 1,
                  failed: (useAppStore.getState().currentBatch?.failed ?? 0) + 1,
                });
              },
              onBatchProgress: () => {},
              onBatchComplete: (succeeded, failed) => {
                updateCurrentBatch({
                  isRunning: false,
                  completedAt: new Date().toISOString(),
                });
              },
            });
          }}
          onRetryJob={(jobId) => {
            updatePipelineJob(jobId, { status: "queued", error: undefined });
          }}
        />
      )}

      {activeTab === "results" && (
        <ResultsTab
          jobs={pipelineJobs.filter(
            (j) => j.status === "ready" || j.status === "applied" || j.status === "skipped"
          )}
          onSkip={(id) => updatePipelineJob(id, { status: "skipped" })}
          onMarkApplied={(id) =>
            updatePipelineJob(id, { status: "applied", appliedAt: new Date().toISOString() })
          }
          onExport={async (job, format) => {
            if (!job.tailoredResult) return;
            try {
              const res = await fetch("/api/export-resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  resume: job.tailoredResult.tailoredResume,
                  format,
                }),
              });
              if (!res.ok) throw new Error("Export failed");
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${job.company}_${job.jobTitle}_resume.${format}`;
              a.click();
              URL.revokeObjectURL(url);
            } catch (err) {
              console.error("Export error:", err);
            }
          }}
        />
      )}
    </div>
  );
}

/* ──────────────────────────── PIPELINE STATS ──────────────────────────── */

function PipelineStats({
  jobs,
  batch,
}: {
  jobs: PipelineJob[];
  batch: BatchRun | null;
}) {
  const queued = jobs.filter((j) => j.status === "queued").length;
  const processing = jobs.filter((j) => j.status === "analyzing" || j.status === "tailoring").length;
  const ready = jobs.filter((j) => j.status === "ready").length;
  const applied = jobs.filter((j) => j.status === "applied").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const avgScore =
    jobs.filter((j) => j.tailoredScore).length > 0
      ? Math.round(
          jobs
            .filter((j) => j.tailoredScore)
            .reduce((sum, j) => sum + (j.tailoredScore ?? 0), 0) /
            jobs.filter((j) => j.tailoredScore).length
        )
      : 0;

  return (
    <div className="grid grid-cols-6 gap-3">
      <MiniStat label="Queued" value={queued} color="text-neutral-600" />
      <MiniStat
        label="Processing"
        value={processing}
        color="text-blue-600"
        pulse={processing > 0}
      />
      <MiniStat label="Ready" value={ready} color="text-emerald-600" />
      <MiniStat label="Applied" value={applied} color="text-indigo-600" />
      <MiniStat label="Failed" value={failed} color="text-red-500" />
      <MiniStat label="Avg Score" value={avgScore > 0 ? `${avgScore}%` : "—"} color="text-amber-600" />
    </div>
  );
}

function MiniStat({
  label,
  value,
  color,
  pulse,
}: {
  label: string;
  value: number | string;
  color: string;
  pulse?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 text-center bg-white">
      <p className={`text-lg font-bold tabular-nums ${color} ${pulse ? "animate-pulse" : ""}`}>
        {value}
      </p>
      <p className="text-[10px] text-neutral-400 uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}

/* ──────────────────────────── ADD JOBS TAB ──────────────────────────── */

function AddJobsTab({
  resumeText,
  parsedResume,
  onResumeUpload,
  onResumeParsed,
  onJobsAdded,
}: {
  resumeText: string;
  parsedResume: ParsedResume | null;
  onResumeUpload: (text: string) => void;
  onResumeParsed: (resume: any) => void;
  onJobsAdded: (jobs: PipelineJob[]) => void;
}) {
  const [jdText, setJdText] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [addMode, setAddMode] = useState<"single" | "bulk">("single");
  const [singleJob, setSingleJob] = useState({
    title: "",
    company: "",
    location: "",
    url: "",
    easyApply: false,
  });
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch("/api/upload-resume", { method: "POST", body: formData });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const { text } = await uploadRes.json();
      onResumeUpload(text);

      // Auto-parse
      setIsParsing(true);
      const parseRes = await fetch("/api/parse-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeText: text }),
      });
      if (!parseRes.ok) throw new Error("Parse failed");
      const { parsedResume: parsed } = await parseRes.json();
      onResumeParsed(parsed);
    } catch (err) {
      console.error("Resume upload error:", err);
    } finally {
      setIsUploading(false);
      setIsParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [onResumeUpload, onResumeParsed]);

  const handleAddJobs = () => {
    if (addMode === "single") {
      if (!jdText.trim()) return;
      const job: PipelineJob = {
        id: generateJobId(),
        jobTitle: singleJob.title || "Untitled Role",
        company: singleJob.company || "Unknown",
        location: singleJob.location || "",
        jobUrl: singleJob.url || "",
        jobDescription: jdText,
        source: "manual",
        easyApply: singleJob.easyApply,
        status: "queued",
        addedAt: new Date().toISOString(),
      };
      onJobsAdded([job]);
      setJdText("");
      setSingleJob({ title: "", company: "", location: "", url: "", easyApply: false });
    } else {
      // Bulk mode: split by separator
      const blocks = jdText
        .split(/\n(?:---+|===+)\n/)
        .map((b) => b.trim())
        .filter((b) => b.length > 50);

      const jobs: PipelineJob[] = blocks.map((block) => {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        return {
          id: generateJobId(),
          jobTitle: lines[0]?.length < 100 ? lines[0] : "Untitled Role",
          company: lines[1]?.length < 80 ? lines[1].replace(/^at\s+/i, "") : "Unknown",
          location: "",
          jobUrl: "",
          jobDescription: block,
          source: "manual",
          easyApply: false,
          status: "queued" as const,
          addedAt: new Date().toISOString(),
        };
      });

      if (jobs.length > 0) {
        onJobsAdded(jobs);
        setJdText("");
      }
    }
  };

  return (
    <div className="space-y-6">
      {/* Step 1: Upload base resume (if not already done) */}
      <div className="border border-neutral-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-neutral-900">Step 1: Base Resume</h3>
            <p className="text-[12px] text-neutral-400 mt-0.5">
              Upload your master resume. All jobs will be tailored from this.
            </p>
          </div>
          {parsedResume && (
            <span className="text-[12px] font-medium text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full">
              {parsedResume.contactInfo.name} — Ready
            </span>
          )}
        </div>

        {!parsedResume ? (
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
              }}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={isUploading || isParsing}
              className="px-4 py-2 text-[13px] font-medium bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 disabled:opacity-50 transition-colors"
            >
              {isUploading ? "Uploading..." : isParsing ? "Parsing..." : "Upload Resume"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            className="text-[12px] text-indigo-600 hover:text-indigo-700 font-medium"
          >
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
              }}
              className="hidden"
            />
            Change resume
          </button>
        )}
      </div>

      {/* Step 2: Add Jobs */}
      <div className="border border-neutral-200 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">Step 2: Add Jobs</h3>
          <p className="text-[12px] text-neutral-400 mt-0.5">
            Paste job descriptions manually, or use the Chrome Extension to scrape from LinkedIn.
          </p>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => setAddMode("single")}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
              addMode === "single"
                ? "bg-indigo-600 text-white"
                : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
            }`}
          >
            Single Job
          </button>
          <button
            onClick={() => setAddMode("bulk")}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
              addMode === "bulk"
                ? "bg-indigo-600 text-white"
                : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
            }`}
          >
            Bulk Paste
          </button>
        </div>

        {addMode === "single" && (
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Job Title (e.g., Senior PM)"
              value={singleJob.title}
              onChange={(e) => setSingleJob({ ...singleJob, title: e.target.value })}
              className="col-span-1 px-3 py-2 text-[13px] border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
            />
            <input
              type="text"
              placeholder="Company"
              value={singleJob.company}
              onChange={(e) => setSingleJob({ ...singleJob, company: e.target.value })}
              className="col-span-1 px-3 py-2 text-[13px] border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
            />
            <input
              type="text"
              placeholder="Location (e.g., Toronto, ON)"
              value={singleJob.location}
              onChange={(e) => setSingleJob({ ...singleJob, location: e.target.value })}
              className="col-span-1 px-3 py-2 text-[13px] border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
            />
            <input
              type="text"
              placeholder="Job URL (optional)"
              value={singleJob.url}
              onChange={(e) => setSingleJob({ ...singleJob, url: e.target.value })}
              className="col-span-1 px-3 py-2 text-[13px] border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
            />
            <label className="col-span-2 flex items-center gap-2 text-[12px] text-neutral-500">
              <input
                type="checkbox"
                checked={singleJob.easyApply}
                onChange={(e) => setSingleJob({ ...singleJob, easyApply: e.target.checked })}
                className="rounded border-neutral-300"
              />
              LinkedIn Easy Apply available
            </label>
          </div>
        )}

        <textarea
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          placeholder={
            addMode === "single"
              ? "Paste the full job description here..."
              : "Paste multiple job descriptions separated by --- or ===\n\n---\n\nJob 1 description here...\n\n---\n\nJob 2 description here..."
          }
          rows={addMode === "single" ? 8 : 14}
          className="w-full px-4 py-3 text-[13px] text-neutral-700 border border-neutral-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 placeholder:text-neutral-300"
        />

        <div className="flex items-center justify-between">
          <p className="text-[11px] text-neutral-300">
            {addMode === "bulk" && jdText.trim()
              ? `${jdText.split(/\n(?:---+|===+)\n/).filter((b) => b.trim().length > 50).length} jobs detected`
              : ""}
          </p>
          <button
            onClick={handleAddJobs}
            disabled={!jdText.trim()}
            className="px-5 py-2 text-[13px] font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-30 transition-colors"
          >
            {addMode === "single" ? "Add to Queue" : "Add All to Queue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── QUEUE TAB ──────────────────────────── */

function QueueTab({
  jobs,
  parsedResume,
  mode,
  onModeChange,
  currentBatch,
  onRemoveJob,
  onClearAll,
  onStartBatch,
  onRetryJob,
}: {
  jobs: PipelineJob[];
  parsedResume: any;
  mode: "fast" | "pro";
  onModeChange: (m: "fast" | "pro") => void;
  currentBatch: BatchRun | null;
  onRemoveJob: (id: string) => void;
  onClearAll: () => void;
  onStartBatch: () => void;
  onRetryJob: (id: string) => void;
}) {
  const isRunning = currentBatch?.isRunning ?? false;
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const failedJobs = jobs.filter((j) => j.status === "failed");

  return (
    <div className="space-y-4">
      {/* Batch Controls */}
      <div className="flex items-center justify-between border border-neutral-200 rounded-xl p-4">
        <div className="flex items-center gap-4">
          {/* Mode Toggle */}
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-neutral-400">Model:</span>
            <div className="flex bg-neutral-100 rounded-lg p-0.5">
              <button
                onClick={() => onModeChange("fast")}
                className={`px-3 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  mode === "fast"
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-400"
                }`}
              >
                Haiku (fast)
              </button>
              <button
                onClick={() => onModeChange("pro")}
                className={`px-3 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  mode === "pro"
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-400"
                }`}
              >
                Sonnet (pro)
              </button>
            </div>
          </div>

          {/* Cost estimate */}
          <span className="text-[11px] text-neutral-300">
            Est. cost: ~${(queuedCount * (mode === "fast" ? 0.01 : 0.04)).toFixed(2)} for {queuedCount} jobs
          </span>
        </div>

        <div className="flex items-center gap-2">
          {failedJobs.length > 0 && (
            <button
              onClick={() => failedJobs.forEach((j) => onRetryJob(j.id))}
              className="px-3 py-1.5 text-[12px] font-medium text-amber-600 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors"
            >
              Retry {failedJobs.length} Failed
            </button>
          )}
          <button
            onClick={onClearAll}
            disabled={isRunning}
            className="px-3 py-1.5 text-[12px] font-medium text-red-500 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-30 transition-colors"
          >
            Clear All
          </button>
          <button
            onClick={onStartBatch}
            disabled={isRunning || queuedCount === 0 || !parsedResume}
            className="px-5 py-2 text-[13px] font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-30 transition-colors"
          >
            {isRunning
              ? `Processing... (${currentBatch?.processed ?? 0}/${currentBatch?.totalJobs ?? 0})`
              : !parsedResume
              ? "Upload Resume First"
              : `Tailor All (${queuedCount})`}
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      {isRunning && currentBatch && (
        <div className="w-full bg-neutral-100 rounded-full h-2 overflow-hidden">
          <div
            className="bg-indigo-600 h-2 rounded-full transition-all duration-500"
            style={{
              width: `${
                currentBatch.totalJobs > 0
                  ? (currentBatch.processed / currentBatch.totalJobs) * 100
                  : 0
              }%`,
            }}
          />
        </div>
      )}

      {/* Job List */}
      {jobs.length === 0 ? (
        <div className="border border-dashed border-neutral-200 rounded-xl py-16 text-center">
          <p className="text-sm text-neutral-400">No jobs in queue.</p>
          <p className="text-[12px] text-neutral-300 mt-1">
            Go to the Add Jobs tab to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onRemove={() => onRemoveJob(job.id)}
              onRetry={() => onRetryJob(job.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({
  job,
  onRemove,
  onRetry,
}: {
  job: PipelineJob;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const statusConfig: Record<
    PipelineStatus,
    { label: string; color: string; bg: string }
  > = {
    queued: { label: "Queued", color: "text-neutral-500", bg: "bg-neutral-100" },
    analyzing: { label: "Analyzing JD...", color: "text-blue-600", bg: "bg-blue-50" },
    tailoring: { label: "Tailoring...", color: "text-indigo-600", bg: "bg-indigo-50" },
    ready: { label: "Ready", color: "text-emerald-600", bg: "bg-emerald-50" },
    applying: { label: "Applying...", color: "text-amber-600", bg: "bg-amber-50" },
    applied: { label: "Applied", color: "text-emerald-700", bg: "bg-emerald-50" },
    skipped: { label: "Skipped", color: "text-neutral-400", bg: "bg-neutral-50" },
    failed: { label: "Failed", color: "text-red-500", bg: "bg-red-50" },
  };

  const status = statusConfig[job.status];
  const isProcessing = job.status === "analyzing" || job.status === "tailoring";

  return (
    <div
      className={`border rounded-xl p-4 flex items-center justify-between transition-all ${
        isProcessing ? "border-indigo-200 bg-indigo-50/30" : "border-neutral-200 bg-white"
      }`}
    >
      <div className="flex items-center gap-4 min-w-0">
        {/* Status indicator */}
        <div className="flex-shrink-0">
          {isProcessing ? (
            <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          ) : (
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold ${status.bg} ${status.color}`}
            >
              {job.status === "ready" || job.status === "applied"
                ? job.tailoredScore ?? "—"
                : job.status === "failed"
                ? "!"
                : "—"}
            </div>
          )}
        </div>

        {/* Job info */}
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-neutral-900 truncate">
            {job.jobTitle}
          </p>
          <p className="text-[12px] text-neutral-400 truncate">
            {job.company}
            {job.location ? ` · ${job.location}` : ""}
            {job.easyApply && (
              <span className="ml-2 text-[10px] font-medium text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded">
                Easy Apply
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        {/* Score improvement */}
        {job.originalScore != null && job.tailoredScore != null && (
          <div className="text-[11px] tabular-nums text-right">
            <span className="text-neutral-400">{job.originalScore}</span>
            <span className="text-neutral-300 mx-1">→</span>
            <span className="text-emerald-600 font-medium">{job.tailoredScore}</span>
            <span className="text-emerald-500 text-[10px] ml-1">
              +{job.tailoredScore - job.originalScore}
            </span>
          </div>
        )}

        {/* Status badge */}
        <span
          className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${status.bg} ${status.color}`}
        >
          {status.label}
        </span>

        {/* Actions */}
        {job.status === "failed" && (
          <button
            onClick={onRetry}
            className="text-[11px] text-amber-600 hover:text-amber-700 font-medium"
          >
            Retry
          </button>
        )}
        {(job.status === "queued" || job.status === "failed" || job.status === "skipped") && (
          <button
            onClick={onRemove}
            className="text-[11px] text-neutral-300 hover:text-red-500 transition-colors"
          >
            Remove
          </button>
        )}

        {/* Link to job */}
        {job.jobUrl && (
          <a
            href={job.jobUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-indigo-500 hover:text-indigo-600"
          >
            View
          </a>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────── RESULTS TAB ──────────────────────────── */

function ResultsTab({
  jobs,
  onSkip,
  onMarkApplied,
  onExport,
}: {
  jobs: PipelineJob[];
  onSkip: (id: string) => void;
  onMarkApplied: (id: string) => void;
  onExport: (job: PipelineJob, format: "pdf" | "docx") => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [jdExpandedId, setJdExpandedId] = useState<string | null>(null);

  /** Generate a JD PDF blob and trigger download */
  const downloadJdPdf = async (job: PipelineJob) => {
    try {
      const res = await fetch("/api/export-jd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobTitle: job.jobTitle,
          company: job.company,
          location: job.location,
          jobDescription: job.jobDescription,
        }),
      });
      if (!res.ok) throw new Error("JD export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${job.company}_${job.jobTitle}_JD.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("JD PDF export error:", err);
    }
  };

  if (jobs.length === 0) {
    return (
      <div className="border border-dashed border-neutral-200 rounded-xl py-16 text-center">
        <p className="text-sm text-neutral-400">No results yet.</p>
        <p className="text-[12px] text-neutral-300 mt-1">
          Process jobs from the Queue tab to see tailored resumes here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="flex items-center justify-between text-[12px] text-neutral-400 px-1">
        <span>
          {jobs.filter((j) => j.status === "ready").length} ready ·{" "}
          {jobs.filter((j) => j.status === "applied").length} applied ·{" "}
          {jobs.filter((j) => j.status === "skipped").length} skipped
        </span>
      </div>

      {jobs.map((job) => {
        // Fix for old scraped data where company got the job title and location got the company
        const titleLower = (job.jobTitle || "").toLowerCase().trim();
        const companyLower = (job.company || "").toLowerCase().trim();
        let displayCompany = job.company || "Unknown";
        let displayLocation = job.location || "";

        if (companyLower && titleLower && (companyLower === titleLower || titleLower.includes(companyLower) || companyLower.includes(titleLower))) {
          // Company field has the title — swap: use location as company
          if (job.location && job.location.toLowerCase() !== titleLower) {
            displayCompany = job.location;
            displayLocation = "";
          }
        }

        return (
        <div key={job.id} className="border border-neutral-200 rounded-xl overflow-hidden">
          {/* Job header */}
          <div
            className="p-4 flex items-center justify-between cursor-pointer hover:bg-neutral-50 transition-colors"
            onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold ${
                  job.status === "applied"
                    ? "bg-emerald-50 text-emerald-600"
                    : job.status === "skipped"
                    ? "bg-neutral-50 text-neutral-400"
                    : "bg-indigo-50 text-indigo-600"
                }`}
              >
                {job.tailoredScore ?? "—"}
              </div>
              <div>
                <p className="text-[13px] font-medium text-neutral-900">{job.jobTitle}</p>
                <p className="text-[12px] text-neutral-400">{displayCompany}{displayLocation ? ` · ${displayLocation}` : ""}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {job.status === "ready" && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkApplied(job.id);
                    }}
                    className="px-3 py-1.5 text-[11px] font-medium bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors"
                  >
                    Mark Applied
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSkip(job.id);
                    }}
                    className="px-3 py-1.5 text-[11px] font-medium text-neutral-400 hover:text-neutral-600 transition-colors"
                  >
                    Skip
                  </button>
                </>
              )}
              <span className="text-neutral-300 text-[16px]">
                {expandedId === job.id ? "▲" : "▼"}
              </span>
            </div>
          </div>

          {/* Expanded content */}
          {expandedId === job.id && job.tailoredResult && (
            <div className="border-t border-neutral-100 p-5 space-y-5 bg-neutral-50/50">
              {/* Score breakdown */}
              {job.tailoredResult.matchBreakdown && (
                <div className="grid grid-cols-3 gap-3">
                  {Object.entries(job.tailoredResult.matchBreakdown).map(([key, val]) => (
                    <div key={key} className="text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-neutral-400 capitalize">
                          {key.replace(/([A-Z])/g, " $1")}
                        </span>
                        <span className="font-medium text-neutral-700">
                          {val.score}{"max" in val ? `/${val.max}` : ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Resume Downloads */}
              <div className="bg-white rounded-lg border border-neutral-200 p-4">
                <h4 className="text-[12px] font-semibold text-neutral-700 mb-3">Tailored Resume</h4>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onExport(job, "pdf")}
                    className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                  >
                    <span>↓</span> Download PDF
                  </button>
                  <button
                    onClick={() => onExport(job, "docx")}
                    className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium bg-white text-neutral-700 border border-neutral-300 rounded-lg hover:bg-neutral-50 transition-colors"
                  >
                    <span>↓</span> Download DOCX
                  </button>
                </div>
              </div>

              {/* Job Description */}
              {job.jobDescription && (
                <div className="bg-white rounded-lg border border-neutral-200 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[12px] font-semibold text-neutral-700">Job Description</h4>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => downloadJdPdf(job)}
                        className="text-[11px] text-indigo-500 hover:text-indigo-600 font-medium"
                      >
                        Download PDF
                      </button>
                      <button
                        onClick={() => setJdExpandedId(jdExpandedId === job.id ? null : job.id)}
                        className="text-[11px] text-neutral-400 hover:text-neutral-600 font-medium"
                      >
                        {jdExpandedId === job.id ? "Collapse" : "View"}
                      </button>
                    </div>
                  </div>
                  {jdExpandedId === job.id && (
                    <div className="mt-2 max-h-[300px] overflow-y-auto">
                      <p className="text-[12px] text-neutral-600 leading-relaxed whitespace-pre-wrap">
                        {job.jobDescription}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Cover letter */}
              <div className="bg-white rounded-lg border border-neutral-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-[12px] font-semibold text-neutral-700">Cover Letter</h4>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(job.tailoredResult?.coverLetter ?? "");
                      setCopiedId(job.id);
                      setTimeout(() => setCopiedId(null), 2000);
                    }}
                    className="text-[11px] text-indigo-500 hover:text-indigo-600 font-medium"
                  >
                    {copiedId === job.id ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-[12px] text-neutral-600 leading-relaxed whitespace-pre-wrap line-clamp-6">
                  {job.tailoredResult.coverLetter}
                </p>
              </div>

              {/* Changes made */}
              {job.tailoredResult.changes?.length > 0 && (
                <div className="bg-white rounded-lg border border-neutral-200 p-4">
                  <h4 className="text-[12px] font-semibold text-neutral-700 mb-2">
                    Optimization Changes
                  </h4>
                  <div className="space-y-1">
                    {job.tailoredResult.changes.map((c, i) => (
                      <p key={i} className="text-[11px] text-neutral-500">
                        <span className="font-medium text-neutral-600 capitalize">
                          {c.category}:
                        </span>{" "}
                        {c.text}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
