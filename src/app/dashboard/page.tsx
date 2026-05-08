"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  useAppStore,
  PipelineJob,
  Application,
  ResumeDefect,
} from "@/store/useAppStore";
import { runBatch, generateJobId } from "@/lib/batchProcessor";
import BudgetWidget from "@/components/BudgetWidget";

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
}

interface ResumeMapEntry {
  key: string;
  jobTitle: string;
  company: string;
  filename: string;
  matchScore: number;
  jobUrl: string;
  createdAt: number;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** Returns last N days as { label: "Apr 7", count: 0 }[] */
function buildDailyActivity(jobs: TrackableJob[], days = 14) {
  const buckets: { label: string; date: string; count: number }[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.push({
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      date: key,
      count: 0,
    });
  }
  for (const j of jobs) {
    const key = j.date?.slice(0, 10);
    const b = buckets.find((b) => b.date === key);
    if (b) b.count++;
  }
  return buckets;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Page wrapper (Suspense for useSearchParams)                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

export default function DashboardPageWrapper() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-neutral-400">Loading…</div>}>
      <DashboardPage />
    </Suspense>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Main page                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    applications,
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
    updateApplicationStatus,
    addApplication,
    userProfile,
    parsedResumeSummary,
  } = useAppStore();

  /* ── resume preview modal ─────────────────────────────────────────────── */
  const [resumeModalOpen, setResumeModalOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"idle" | "done" | "error">("idle");

  /* ── panel state ──────────────────────────────────────────────────────── */
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [addMode, setAddMode] = useState<"single" | "bulk">("single");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeHistoryTab, setActiveHistoryTab] = useState<"all" | "applied" | "ready" | "failed">("all");

  /* ── single job form ──────────────────────────────────────────────────── */
  const [jobTitle, setJobTitle] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [easyApply, setEasyApply] = useState(false);
  const [bulkText, setBulkText] = useState("");

  /* ── batch run ────────────────────────────────────────────────────────── */
  const [mode, setMode] = useState<"fast" | "pro">("fast");

  /* ── funnel stats (synced from extension via pipeline-bridge) ──────────── */
  interface FunnelStats { opened: number; formFilled: number; resumeTailored: number; completed: number; }
  const [funnelStats, setFunnelStats] = useState<FunnelStats>({ opened: 0, formFilled: 0, resumeTailored: 0, completed: 0 });

  /* ── recent tailored resumes (synced from extension via pipeline-bridge) ── */
  const [recentResumes, setRecentResumes] = useState<ResumeMapEntry[]>([]);
  const isRunning =
    pipelineJobs.some((j) => j.status === "analyzing" || j.status === "tailoring") &&
    currentBatch?.isRunning === true;

  /* ── import from URL ──────────────────────────────────────────────────── */
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
  }, [addPipelineJobs]);

  useEffect(() => {
    const jobsParam = searchParams.get("jobs");
    if (jobsParam) {
      try { importJobs(JSON.parse(jobsParam)); } catch {}
    }
  }, [searchParams, importJobs]);

  useEffect(() => {
    function onBridgeMessage(e: MessageEvent) {
      if (e.data?.__aa_bridge === "IMPORT_JOBS" && Array.isArray(e.data.jobs)) {
        importJobs(e.data.jobs);
      }
    }
    window.addEventListener("message", onBridgeMessage);
    return () => window.removeEventListener("message", onBridgeMessage);
  }, [importJobs]);

  /* ── sync funnel stats from extension ────────────────────────────────── */
  useEffect(() => {
    function loadFunnel() {
      try {
        const raw = localStorage.getItem("autoapply-funnel-stats");
        if (raw) setFunnelStats(JSON.parse(raw));
      } catch {}
    }
    loadFunnel();
    function onFunnelSync(e: CustomEvent) {
      if (e.detail) setFunnelStats(e.detail as FunnelStats);
    }
    window.addEventListener("autoapply-funnel-sync", onFunnelSync as EventListener);
    return () => window.removeEventListener("autoapply-funnel-sync", onFunnelSync as EventListener);
  }, []);

  /* ── sync recent tailored resumes from extension ─────────────────────── */
  useEffect(() => {
    function loadResumes() {
      try {
        const raw = localStorage.getItem("autoapply-resume-map");
        if (raw) {
          const arr: ResumeMapEntry[] = JSON.parse(raw);
          // Deduplicate by jobTitle + company (extension may write same entry twice)
          const seen = new Set<string>();
          const unique = arr.filter(r => {
            const key = `${r.jobTitle?.trim().toLowerCase()}__${r.company?.trim().toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setRecentResumes(unique.slice(0, 12));
        }
      } catch {}
    }
    loadResumes();
    window.addEventListener("autoapply-resume-map-sync", loadResumes as EventListener);
    return () => window.removeEventListener("autoapply-resume-map-sync", loadResumes as EventListener);
  }, []);

  /* ── sync completed apps from extension ──────────────────────────────── */
  useEffect(() => {
    function syncCompleted() {
      try {
        const stored = localStorage.getItem("autoapply-completed-applications");
        if (!stored) return;
        const completed = JSON.parse(stored);
        if (!Array.isArray(completed)) return;
        // Build a seen set from this loop's own additions to guard against same-tick dedup failures
        const seenThisSync = new Set(
          [...applications, ...pipelineJobs].map((j) => `${j.jobTitle?.trim().toLowerCase()}__${j.company?.trim().toLowerCase()}`)
        );
        for (const app of completed) {
          const key = `${app.jobTitle?.trim().toLowerCase()}__${app.company?.trim().toLowerCase()}`;
          const inApps = seenThisSync.has(key);
          const inPipeline = pipelineJobs.some((j) => j.jobTitle === app.jobTitle && j.company === app.company);
          if (!inApps && !inPipeline) {
            seenThisSync.add(key); // prevent same batch from re-adding
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
          } else if (inPipeline) {
            const pj = pipelineJobs.find((j) => j.jobTitle === app.jobTitle && j.company === app.company);
            if (pj && pj.status !== "applied") {
              updatePipelineJob(pj.id, { status: "applied", appliedAt: app.completedAt || new Date().toISOString() });
            }
          }
        }
        localStorage.removeItem("autoapply-completed-applications");
      } catch {}
    }
    syncCompleted();
    window.addEventListener("autoapply-completed-sync", syncCompleted);
    return () => window.removeEventListener("autoapply-completed-sync", syncCompleted);
  }, [applications, pipelineJobs, addApplication, updatePipelineJob]);

  /* ── add single job ───────────────────────────────────────────────────── */
  function handleAddJob(e: React.FormEvent) {
    e.preventDefault();
    if (!jobTitle.trim() || !company.trim()) return;
    addPipelineJob({
      id: generateJobId(),
      jobTitle: jobTitle.trim(),
      company: company.trim(),
      location: location.trim(),
      jobUrl: jobUrl.trim(),
      jobDescription: jobDescription.trim(),
      source: "manual",
      easyApply,
      status: "queued",
      addedAt: new Date().toISOString(),
    });
    setJobTitle(""); setCompany(""); setLocation(""); setJobUrl("");
    setJobDescription(""); setEasyApply(false);
    setAddPanelOpen(false);
  }

  /* ── bulk paste ───────────────────────────────────────────────────────── */
  function handleBulkAdd() {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    const jobs: PipelineJob[] = lines.map((line) => {
      const [jobTitle = "Unknown Role", company = "Unknown Company"] = line.split("|").map((s) => s.trim());
      return { id: generateJobId(), jobTitle, company, location: "", jobUrl: "", jobDescription: "", source: "manual" as const, easyApply: false, status: "queued" as const, addedAt: new Date().toISOString() };
    });
    if (jobs.length > 0) { addPipelineJobs(jobs); setBulkText(""); setAddPanelOpen(false); }
  }

  /* ── run batch ────────────────────────────────────────────────────────── */
  async function handleRunBatch() {
    const queued = pipelineJobs.filter((j) => j.status === "queued");
    if (queued.length === 0 || !pipelineResumeText || !pipelineParsedResume) return;
    const batch: import("@/store/useAppStore").BatchRun = {
      id: `batch_${Date.now()}`,
      startedAt: new Date().toISOString(),
      totalJobs: queued.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      isRunning: true,
    };
    setCurrentBatch(batch);
    try {
      await runBatch(queued, pipelineParsedResume, mode, {
        onJobStart: (id) => updatePipelineJob(id, { status: "analyzing" }),
        onJobAnalyzed: (id) => updatePipelineJob(id, { status: "tailoring" }),
        onJobComplete: (id, score, tailoredScore) => updatePipelineJob(id, { status: "ready", originalScore: score, tailoredScore }),
        onJobFailed: (id, error) => updatePipelineJob(id, { status: "failed", error }),
        onBatchProgress: (processed, total) => updateCurrentBatch({ processed }),
        onBatchComplete: (succeeded, failed) => updateCurrentBatch({ succeeded, failed, isRunning: false, completedAt: new Date().toISOString() }),
      });
    } catch {}
  }

  /* ── metrics ──────────────────────────────────────────────────────────── */
  const trackableJobs: TrackableJob[] = [
    ...pipelineJobs.filter((j) => ["ready","applied","skipped","failed"].includes(j.status)).map((j) => ({
      id: j.id, jobTitle: j.jobTitle, company: j.company, jobUrl: j.jobUrl,
      score: j.tailoredScore ?? 0, originalScore: j.originalScore ?? 0,
      status: j.status === "ready" ? "matched" : j.status,
      date: j.appliedAt ?? j.processedAt ?? j.addedAt, source: "pipeline" as const,
    })),
    ...applications.map((a) => ({
      id: a.id, jobTitle: a.jobTitle, company: a.company, jobUrl: a.jobUrl,
      score: a.matchScore, originalScore: 0, status: a.status,
      date: a.appliedAt, source: "manual" as const, defects: a.defects,
    })),
  ];

  const today = new Date().toISOString().slice(0, 10);
  const totalApplied = pipelineJobs.filter((j) => j.status === "applied").length + applications.filter((a) => a.status === "applied").length;
  const appliedToday = trackableJobs.filter((j) => (j.status === "applied" || j.status === "matched") && j.date?.slice(0, 10) === today).length;
  const pipelineQueued = pipelineJobs.filter((j) => j.status === "queued").length;
  const pipelineProcessing = pipelineJobs.filter((j) => j.status === "analyzing" || j.status === "tailoring").length;
  const pipelineReady = pipelineJobs.filter((j) => j.status === "ready").length;
  const totalInterviewing = applications.filter((a) => a.status === "interviewing").length;
  const totalOffers = applications.filter((a) => a.status === "offer").length;
  const allScored = trackableJobs.filter((j) => j.score > 0);
  const avgScore = allScored.length > 0 ? Math.round(allScored.reduce((s, j) => s + j.score, 0) / allScored.length) : 0;
  const responseRate = totalApplied > 0 ? Math.round(((totalInterviewing + totalOffers) / totalApplied) * 100) : 0;
  const openJobs = pipelineJobs.filter((j) => !["applied","skipped"].includes(j.status)).length;

  const dailyActivity = buildDailyActivity(trackableJobs);
  const maxActivity = Math.max(...dailyActivity.map((d) => d.count), 1);

  /* ── filtered history ─────────────────────────────────────────────────── */
  const filteredJobs = trackableJobs
    .filter((j) => {
      if (activeHistoryTab === "applied" && j.status !== "applied") return false;
      if (activeHistoryTab === "ready" && j.status !== "matched") return false;
      if (activeHistoryTab === "failed" && j.status !== "failed") return false;
      if (search) {
        const q = search.toLowerCase();
        return j.jobTitle.toLowerCase().includes(q) || j.company.toLowerCase().includes(q);
      }
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const profileName = userProfile
    ? `${userProfile.firstName ?? ""} ${userProfile.lastName ?? ""}`.trim()
    : null;

  /* ── JSX ──────────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-neutral-50">
      {/* ── HERO HEADER ─────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-indigo-300 text-sm font-medium">{fmtDate(new Date())}</p>
              <h1 className="text-2xl font-bold mt-0.5">
                {greeting()}{profileName ? `, ${profileName.split(" ")[0]}` : ""}
              </h1>
              <p className="text-indigo-300 text-sm mt-1">
                {totalApplied === 0
                  ? "Your job search command centre — let's get you hired."
                  : `${totalApplied} application${totalApplied !== 1 ? "s" : ""} sent · ${openJobs} jobs in pipeline`}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setAddPanelOpen(true)}
                className="flex items-center gap-1.5 bg-white text-indigo-700 font-semibold text-sm px-4 py-2 rounded-lg hover:bg-indigo-50 transition-colors"
              >
                <span className="text-lg leading-none">+</span> Add Jobs
              </button>
              <a
                href="https://www.linkedin.com/jobs/search/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-indigo-600/40 border border-indigo-500/50 text-white font-medium text-sm px-4 py-2 rounded-lg hover:bg-indigo-600/60 transition-colors"
              >
                LinkedIn Jobs →
              </a>
            </div>
          </div>

          {/* KPI Strip */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mt-7">
            {[
              { label: "Applied", value: totalApplied > 0 ? totalApplied : "0", sub: "all time", accent: "text-white", highlight: totalApplied > 0 },
              { label: "Today", value: appliedToday > 0 ? appliedToday : "0", sub: "applications", accent: appliedToday > 0 ? "text-emerald-300" : "text-indigo-200", highlight: appliedToday > 0 },
              { label: "Pipeline", value: openJobs > 0 ? openJobs : "0", sub: `${pipelineQueued} queued`, accent: "text-white", highlight: openJobs > 0 },
              { label: "Match score", value: avgScore > 0 ? `${avgScore}` : "—", sub: "avg · out of 100", accent: avgScore >= 75 ? "text-emerald-300" : avgScore >= 55 ? "text-amber-300" : "text-indigo-200", highlight: avgScore > 0 },
              { label: "Response rate", value: responseRate > 0 ? `${responseRate}%` : "—", sub: `${totalInterviewing} interview${totalInterviewing !== 1 ? "s" : ""}`, accent: responseRate > 20 ? "text-emerald-300" : "text-indigo-200", highlight: responseRate > 0 },
              { label: "Offers", value: totalOffers > 0 ? totalOffers : "—", sub: `${totalInterviewing} interviewing`, accent: totalOffers > 0 ? "text-emerald-300" : "text-indigo-200", highlight: totalOffers > 0 },
            ].map((kpi) => (
              <div key={kpi.label} className={`rounded-xl p-3.5 transition-colors ${kpi.highlight ? "bg-white/15 backdrop-blur" : "bg-white/8 backdrop-blur"}`}>
                <p className="text-[10px] text-indigo-300 font-semibold uppercase tracking-wider">{kpi.label}</p>
                <p className={`text-2xl font-bold mt-1 tabular-nums ${kpi.accent}`}>{kpi.value}</p>
                <p className="text-[10px] text-indigo-400 mt-0.5 truncate">{kpi.sub}</p>
              </div>
            ))}
          </div>

          <BudgetWidget />
        </div>
      </div>

      {/* ── BODY ────────────────────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ── LEFT COLUMN (2/3) ─────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-5">

          {/* Activity Chart */}
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Applications per Day</h2>
                <p className="text-xs text-neutral-400 mt-0.5">Last 14 days</p>
              </div>
              <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-full">
                {trackableJobs.length} total
              </span>
            </div>
            <div className="flex items-end gap-1.5 h-28">
              {dailyActivity.map((day) => (
                <div key={day.date} className="flex-1 flex flex-col items-center gap-1 group">
                  <div className="w-full relative flex items-end justify-center" style={{ height: "80px" }}>
                    {day.count > 0 && (
                      <div
                        className="absolute bottom-0 w-full bg-indigo-500 rounded-t-sm group-hover:bg-indigo-400 transition-colors"
                        style={{ height: `${Math.max(4, (day.count / maxActivity) * 80)}px` }}
                      />
                    )}
                    {day.count === 0 && (
                      <div className="absolute bottom-0 w-full bg-neutral-100 rounded-t-sm" style={{ height: "4px" }} />
                    )}
                    {/* Tooltip */}
                    <div className="absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:flex items-center bg-neutral-900 text-white text-[10px] px-2 py-0.5 rounded whitespace-nowrap z-10">
                      {day.count} job{day.count !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-3 text-[11px] text-neutral-400">
              {dailyActivity.filter((_, i) => i % 7 === 0 || i === dailyActivity.length - 1).map((d) => (
                <span key={d.date}>{d.label}</span>
              ))}
            </div>
          </div>

          {/* Processing banner */}
          {pipelineProcessing > 0 && (
            <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3">
              <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-sm font-medium text-indigo-700">
                Processing {pipelineProcessing} job{pipelineProcessing !== 1 ? "s" : ""}…
              </p>
              <div className="flex-1 bg-indigo-100 rounded-full h-1 ml-2">
                <div
                  className="bg-indigo-500 h-1 rounded-full transition-all"
                  style={{ width: `${pipelineJobs.length > 0 ? ((pipelineJobs.length - pipelineQueued - pipelineProcessing) / pipelineJobs.length) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {/* Application History */}
          <div className="bg-white rounded-2xl border border-neutral-200">
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-neutral-100">
              <h2 className="text-sm font-semibold text-neutral-900">Application History</h2>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search jobs…"
                className="text-xs border border-neutral-200 rounded-lg px-3 py-1.5 w-44 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </div>
            {/* Tab bar */}
            <div className="flex gap-0 border-b border-neutral-100 px-5">
              {(["all", "applied", "ready", "failed"] as const).map((tab) => {
                const counts = { all: trackableJobs.length, applied: trackableJobs.filter(j=>j.status==="applied").length, ready: trackableJobs.filter(j=>j.status==="matched").length, failed: trackableJobs.filter(j=>j.status==="failed").length };
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveHistoryTab(tab)}
                    className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors capitalize ${
                      activeHistoryTab === tab
                        ? "border-indigo-600 text-indigo-700"
                        : "border-transparent text-neutral-400 hover:text-neutral-600"
                    }`}
                  >
                    {tab === "all" ? "All" : tab.charAt(0).toUpperCase() + tab.slice(1)}
                    <span className="ml-1.5 text-[10px] bg-neutral-100 text-neutral-500 px-1.5 py-0.5 rounded-full">{counts[tab]}</span>
                  </button>
                );
              })}
            </div>

            {filteredJobs.length === 0 ? (
              <div className="py-14 text-center">
                {trackableJobs.length === 0 ? (
                  <div className="space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M12 12v4M10 14h4" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-[14px] font-semibold text-neutral-700">No applications yet</p>
                      <p className="text-[13px] text-neutral-400 mt-1">Open LinkedIn Jobs and use the AutoApply extension to start applying.</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-[13px] text-neutral-400">No matching applications</p>
                )}
              </div>
            ) : (
              <div className="divide-y divide-neutral-50">
                {filteredJobs.map((job) => (
                  <JobRow key={job.id} job={job} onStatusChange={(id, status) => {
                    const app = applications.find((a) => a.id === id);
                    if (app) updateApplicationStatus(id, status as any);
                  }} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT COLUMN (1/3) ────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Setup Card */}
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-4">Your Setup</h2>
            <div className="space-y-3">
              {/* Resume */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${parsedResumeSummary ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-400"}`}>
                    {parsedResumeSummary ? "✓" : "!"}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-neutral-800">
                      {parsedResumeSummary ? parsedResumeSummary.name : "Resume"}
                    </p>
                    <p className="text-[11px] text-neutral-400">
                      {parsedResumeSummary
                        ? (pipelineParsedResume?.experience?.length || parsedResumeSummary.jobCount) > 0
                          ? `${pipelineParsedResume?.experience?.length || parsedResumeSummary.jobCount} role${(pipelineParsedResume?.experience?.length || parsedResumeSummary.jobCount) !== 1 ? "s" : ""} found`
                          : "Resume ready"
                        : "Not uploaded"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {parsedResumeSummary && pipelineResumeText && (
                    <button
                      onClick={() => setResumeModalOpen(true)}
                      className="text-[11px] text-neutral-400 hover:text-neutral-600 font-medium"
                    >
                      View
                    </button>
                  )}
                  <Link href={parsedResumeSummary ? "/onboarding?edit=resume" : "/onboarding"} className="text-[11px] text-indigo-600 hover:text-indigo-700 font-medium">
                    {parsedResumeSummary ? "Change" : "Upload →"}
                  </Link>
                </div>
              </div>

              {/* Profile */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${userProfile ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-400"}`}>
                    {userProfile ? "✓" : "!"}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-neutral-800">
                      {userProfile ? `${userProfile.firstName ?? ""} ${userProfile.lastName ?? ""}`.trim() : "Profile"}
                    </p>
                    <p className="text-[11px] text-neutral-400">
                      {userProfile ? userProfile.email || "Profile complete" : "Not set up"}
                    </p>
                  </div>
                </div>
                <Link href="/onboarding?edit=profile" className="text-[11px] text-indigo-600 hover:text-indigo-700 font-medium">
                  {userProfile ? "Edit" : "Setup →"}
                </Link>
              </div>

              {/* Sync button */}
              <div className="pt-1">
                <button
                  onClick={() => {
                    const resumeData = pipelineParsedResume;
                    const profile = userProfile;

                    if (!resumeData && !profile) {
                      setSyncStatus("error");
                      setTimeout(() => setSyncStatus("idle"), 3000);
                      return;
                    }

                    // Write to localStorage with correct keys that pipeline-bridge.js reads
                    if (resumeData) {
                      localStorage.setItem("autoapply-parsed-resume", JSON.stringify(resumeData));
                    }
                    if (profile) {
                      localStorage.setItem("autoapply-user-profile", JSON.stringify(profile));
                    }

                    // Listen for ACK from extension content script before showing success
                    // Timeout after 3s — show error if extension didn't respond
                    let ackReceived = false;
                    const timeout = setTimeout(() => {
                      if (!ackReceived) {
                        setSyncStatus("error");
                        setTimeout(() => setSyncStatus("idle"), 3000);
                        window.removeEventListener("autoapply-sync-ack", onAck as EventListener);
                      }
                    }, 3000);

                    function onAck(e: CustomEvent) {
                      ackReceived = true;
                      clearTimeout(timeout);
                      window.removeEventListener("autoapply-sync-ack", onAck as EventListener);
                      if (e.detail?.ok) {
                        setSyncStatus("done");
                        setTimeout(() => setSyncStatus("idle"), 3000);
                      } else {
                        setSyncStatus("error");
                        setTimeout(() => setSyncStatus("idle"), 3000);
                      }
                    }
                    window.addEventListener("autoapply-sync-ack", onAck as EventListener);

                    // Dispatch the event that pipeline-bridge.js content script listens for
                    window.dispatchEvent(new CustomEvent("autoapply-sync-resume", {
                      detail: {
                        parsedResume: resumeData || undefined,
                        userProfile: profile || undefined,
                      }
                    }));
                  }}
                  className={`w-full text-white text-xs font-semibold py-2 rounded-lg transition-colors ${
                    syncStatus === "done" ? "bg-emerald-600" :
                    syncStatus === "error" ? "bg-red-500" :
                    "bg-indigo-600 hover:bg-indigo-700"
                  }`}
                >
                  {syncStatus === "done" ? "✓ Synced to Extension!" :
                   syncStatus === "error" ? "⚠ Reload extension & retry" :
                   "Sync to Extension"}
                </button>
                <a
                  href="/autoapply-extension.zip"
                  download={`autoapply-extension-${process.env.NEXT_PUBLIC_BUILD_DATE || 'latest'}.zip`}
                  className="w-full flex items-center justify-center gap-1.5 text-[11px] text-neutral-500 hover:text-indigo-600 transition-colors mt-2"
                >
                  ↓ Download Extension ({process.env.NEXT_PUBLIC_BUILD_DATE || 'latest'})
                </a>
              </div>
            </div>
          </div>

          {/* Pipeline Control */}
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Pipeline</h2>
              <button
                onClick={() => setAddPanelOpen(true)}
                className="text-[11px] text-indigo-600 hover:text-indigo-700 font-semibold"
              >
                + Add Jobs
              </button>
            </div>

            {/* Status pills */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[
                { label: "Queued", value: pipelineQueued, color: "bg-neutral-50 text-neutral-600" },
                { label: "Processing", value: pipelineProcessing, color: pipelineProcessing > 0 ? "bg-indigo-50 text-indigo-700" : "bg-neutral-50 text-neutral-600" },
                { label: "Ready", value: pipelineReady, color: pipelineReady > 0 ? "bg-emerald-50 text-emerald-700" : "bg-neutral-50 text-neutral-600" },
              ].map((s) => (
                <div key={s.label} className={`${s.color} rounded-xl p-2.5 text-center`}>
                  <p className="text-lg font-bold">{s.value}</p>
                  <p className="text-[10px] font-medium mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Mode selector */}
            <div className="flex gap-1.5 mb-3">
              {(["fast", "pro"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                    mode === m
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-neutral-500 border-neutral-200 hover:border-indigo-300"
                  }`}
                >
                  {m === "fast" ? "Fast" : "Pro"}
                </button>
              ))}
            </div>

            <button
              onClick={handleRunBatch}
              disabled={pipelineQueued === 0 || !pipelineResumeText || isRunning}
              className={`w-full py-2.5 text-sm font-semibold rounded-xl transition-colors ${
                pipelineQueued > 0 && pipelineResumeText && !isRunning
                  ? "bg-indigo-600 hover:bg-indigo-700 text-white"
                  : "bg-neutral-100 text-neutral-400 cursor-not-allowed"
              }`}
            >
              {isRunning ? "Running…" : `Run Batch (${pipelineQueued} job${pipelineQueued !== 1 ? "s" : ""})`}
            </button>

            {/* Queue list */}
            {pipelineJobs.length > 0 && (
              <div className="mt-4 space-y-1.5 max-h-48 overflow-y-auto">
                {pipelineJobs.slice(0, 20).map((job) => (
                  <div key={job.id} className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg hover:bg-neutral-50 group">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-neutral-800 truncate">{job.company}</p>
                      <p className="text-[10px] text-neutral-400 truncate">{job.jobTitle}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusDot status={job.status} score={job.tailoredScore} />
                      <button onClick={() => removePipelineJob(job.id)} className="opacity-0 group-hover:opacity-100 text-neutral-300 hover:text-red-400 text-xs transition-all">×</button>
                    </div>
                  </div>
                ))}
                {pipelineJobs.length > 20 && (
                  <p className="text-[10px] text-neutral-400 text-center py-1">+{pipelineJobs.length - 20} more</p>
                )}
              </div>
            )}
          </div>

          {/* Funnel */}
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Application Funnel</h2>
            <p className="text-[10px] text-neutral-400 mb-4">Tracked automatically by the extension</p>
            <div className="space-y-3">
              {[
                { label: "Opened from LinkedIn", value: funnelStats.opened,         color: "bg-indigo-400",  emoji: "→" },
                { label: "Form filled",          value: funnelStats.formFilled,     color: "bg-violet-500",  emoji: "→" },
                { label: "Resume tailored",      value: funnelStats.resumeTailored, color: "bg-amber-500",   emoji: "→" },
                { label: "Application sent",     value: funnelStats.completed,      color: "bg-emerald-500", emoji: "✓" },
              ].map((row, i, arr) => {
                const maxVal = Math.max(funnelStats.opened, 1);
                const pct = Math.round((row.value / maxVal) * 100);
                const prevVal = i > 0 ? arr[i-1].value : null;
                const convRate = (prevVal && prevVal > 0) ? Math.round((row.value / prevVal) * 100) : null;
                return (
                  <div key={row.label}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-neutral-600 flex items-center gap-1">
                        <span>{row.emoji}</span> {row.label}
                      </span>
                      <div className="flex items-center gap-2">
                        {convRate !== null && row.value > 0 && (
                          <span className="text-[10px] text-neutral-400">{convRate}%</span>
                        )}
                        <span className="text-xs font-bold text-neutral-800 w-6 text-right">{row.value}</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-neutral-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${row.color} rounded-full transition-all duration-700`}
                        style={{ width: `${funnelStats.opened > 0 ? pct : 0}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {funnelStats.opened === 0 && (
                <p className="text-[11px] text-neutral-400 text-center pt-1">Apply from LinkedIn to see your funnel</p>
              )}
            </div>
          </div>

          {/* Score Distribution */}
          <div className="bg-white rounded-2xl border border-neutral-200 p-5">
            <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3">Avg Match Score</h2>
            <div className="flex items-center justify-center py-3">
              <ScoreGauge score={avgScore} />
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3 text-center">
              <div>
                <p className="text-[10px] text-neutral-400">Low (&lt;60)</p>
                <p className="text-sm font-semibold text-neutral-700">{allScored.filter(j=>j.score<60).length}</p>
              </div>
              <div>
                <p className="text-[10px] text-neutral-400">Good (60–79)</p>
                <p className="text-sm font-semibold text-neutral-700">{allScored.filter(j=>j.score>=60&&j.score<80).length}</p>
              </div>
              <div>
                <p className="text-[10px] text-neutral-400">Great (80+)</p>
                <p className="text-sm font-semibold text-amber-600">{allScored.filter(j=>j.score>=80).length}</p>
              </div>
            </div>
          </div>

          {/* Recent Tailored Resumes */}
          {recentResumes.length > 0 && (
            <div className="bg-white rounded-2xl border border-neutral-200 p-5">
              <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3">
                Recent Tailored Resumes
              </h2>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {recentResumes.map((r) => (
                  <div key={r.key} className="flex items-center gap-2 group py-1.5 border-b border-neutral-50 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-neutral-800 truncate leading-tight">{r.jobTitle}</p>
                      <p className="text-[10px] text-neutral-400 truncate mt-0.5">{r.company}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {r.matchScore > 0 && (
                        <span className={`text-[10px] font-bold ${
                          r.matchScore >= 80 ? "text-emerald-600" :
                          r.matchScore >= 60 ? "text-amber-500" : "text-neutral-400"
                        }`}>{r.matchScore}</span>
                      )}
                      <button
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent("autoapply-download-resume", {
                            detail: { key: r.key, job: { jobTitle: r.jobTitle, company: r.company, jobUrl: r.jobUrl } }
                          }));
                        }}
                        className="text-[10px] bg-indigo-50 text-indigo-600 hover:bg-indigo-100 px-2 py-0.5 rounded font-medium transition-colors whitespace-nowrap"
                      >
                        ↓ PDF
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-neutral-400 mt-2 text-center">
                {recentResumes.length} resume{recentResumes.length !== 1 ? "s" : ""} · stored locally in extension
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── ADD JOBS PANEL ──────────────────────────────────────────────── */}
      {addPanelOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setAddPanelOpen(false)} />
          <div className="relative bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-lg mx-4 shadow-2xl z-10 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
              <h3 className="text-base font-semibold text-neutral-900">Add Jobs to Pipeline</h3>
              <button onClick={() => setAddPanelOpen(false)} className="text-neutral-400 hover:text-neutral-700 text-xl font-light">×</button>
            </div>

            {/* Mode tabs */}
            <div className="flex gap-1 p-4 pb-0">
              {(["single", "bulk"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setAddMode(m)}
                  className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors ${
                    addMode === m ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-neutral-500 border-neutral-200"
                  }`}
                >
                  {m === "single" ? "Single Job" : "Bulk Paste"}
                </button>
              ))}
            </div>

            <div className="p-6">
              {addMode === "single" ? (
                <form onSubmit={handleAddJob} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Job Title *</label>
                      <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required placeholder="Senior PM" className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Company *</label>
                      <input value={company} onChange={(e) => setCompany(e.target.value)} required placeholder="Acme Inc" className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Location</label>
                      <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Toronto, ON" className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Job URL</label>
                      <input value={jobUrl} onChange={(e) => setJobUrl(e.target.value)} placeholder="https://…" className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-neutral-600 mb-1">Job Description</label>
                    <textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={4} placeholder="Paste the job description here…" className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none" />
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="easyApply" checked={easyApply} onChange={(e) => setEasyApply(e.target.checked)} className="rounded" />
                    <label htmlFor="easyApply" className="text-sm text-neutral-600">LinkedIn Easy Apply available</label>
                  </div>
                  <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors">
                    Add to Pipeline
                  </button>
                </form>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-neutral-500">One job per line: <code className="bg-neutral-100 px-1 rounded text-xs">Job Title | Company</code></p>
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    rows={8}
                    placeholder={"Senior PM | Shopify\nProduct Manager | Stripe\nHead of Product | Linear"}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono resize-none"
                  />
                  <button onClick={handleBulkAdd} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors">
                    Add {bulkText.split("\n").filter((l) => l.trim()).length} Jobs
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Resume preview modal */}
      {resumeModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setResumeModalOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
              <div>
                <p className="text-sm font-semibold text-neutral-900">Your Resume</p>
                {parsedResumeSummary && (
                  <p className="text-[11px] text-neutral-400 mt-0.5">
                    {/* [AutoQA fix 2026-04-11] Derive jobCount from live parsedResume data when
                        parsedResumeSummary.jobCount is stale/zero (e.g. uploaded before Redis
                        hydration was deployed, or summary stored without experience count). */}
                    {parsedResumeSummary.name} · {(pipelineParsedResume?.experience?.length || parsedResumeSummary.jobCount)} role{(pipelineParsedResume?.experience?.length || parsedResumeSummary.jobCount) !== 1 ? "s" : ""}
                  </p>
                )}
              </div>
              <button
                onClick={() => setResumeModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-600 text-lg leading-none"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto px-5 py-4 text-[12px] text-neutral-700 whitespace-pre-wrap font-mono leading-relaxed">
              {pipelineResumeText}
            </pre>
            <div className="px-5 py-3 border-t border-neutral-100 flex justify-end">
              <Link
                href="/onboarding?edit=resume"
                className="text-[12px] text-indigo-600 hover:text-indigo-700 font-medium"
                onClick={() => setResumeModalOpen(false)}
              >
                Replace resume →
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

function JobRow({ job, onStatusChange }: { job: TrackableJob; onStatusChange: (id: string, s: string) => void }) {
  const statusColors: Record<string, string> = {
    applied: "bg-indigo-100 text-indigo-700",
    matched: "bg-emerald-100 text-emerald-700",
    interviewing: "bg-violet-100 text-violet-700",
    offer: "bg-amber-100 text-amber-800",
    failed: "bg-red-100 text-red-700",
    rejected: "bg-neutral-100 text-neutral-500",
    skipped: "bg-neutral-100 text-neutral-400",
  };
  const scoreColor = job.score >= 80 ? "text-emerald-600" : job.score >= 60 ? "text-amber-600" : job.score > 0 ? "text-red-500" : "text-neutral-300";

  return (
    <div className="flex items-center gap-3 px-5 py-3 hover:bg-neutral-50 transition-colors group">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-neutral-900 truncate">{job.jobTitle}</p>
          {job.defects && job.defects.length > 0 && (
            <span className="text-amber-500 text-xs">⚠</span>
          )}
        </div>
        <p className="text-xs text-neutral-400 mt-0.5">
          {job.company}
          {job.jobUrl && (
            <a href={job.jobUrl} target="_blank" rel="noopener noreferrer" className="ml-2 text-indigo-400 hover:text-indigo-600">↗</a>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {job.score > 0 && (
          <span className={`text-xs font-bold ${scoreColor}`}>{job.score}</span>
        )}
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColors[job.status] ?? "bg-neutral-100 text-neutral-500"}`}>
          {job.status === "matched" ? "Ready" : job.status.charAt(0).toUpperCase() + job.status.slice(1)}
        </span>
        {job.source === "manual" && (
          <select
            value={job.status}
            onChange={(e) => onStatusChange(job.id, e.target.value)}
            className="opacity-0 group-hover:opacity-100 text-[10px] border border-neutral-200 rounded px-1 py-0.5 text-neutral-500 focus:outline-none transition-opacity"
          >
            {["applied","interviewing","offer","rejected"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status, score }: { status: string; score?: number }) {
  const colors: Record<string, string> = {
    queued: "bg-neutral-300",
    analyzing: "bg-blue-400 animate-pulse",
    tailoring: "bg-indigo-500 animate-pulse",
    ready: "bg-emerald-500",
    applied: "bg-indigo-500",
    failed: "bg-red-400",
    skipped: "bg-neutral-300",
  };
  return (
    <div className="flex items-center gap-1">
      {score !== undefined && score > 0 && (
        <span className="text-[10px] text-neutral-400">{score}</span>
      )}
      <div className={`w-2 h-2 rounded-full ${colors[status] ?? "bg-neutral-300"}`} />
    </div>
  );
}

function ScoreGauge({ score }: { score: number }) {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const pct = score / 100;
  const dash = circ * pct;
  const color = score >= 80 ? "#10b981" : score >= 60 ? "#f59e0b" : score > 0 ? "#ef4444" : "#e5e7eb";

  return (
    <div className="relative w-24 h-24 flex items-center justify-center">
      <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
        <circle cx="48" cy="48" r={r} fill="none" stroke="#f3f4f6" strokeWidth="10" />
        <circle
          cx="48" cy="48" r={r} fill="none"
          stroke={color} strokeWidth="10"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold text-neutral-800">{score > 0 ? score : "—"}</span>
        <span className="text-[9px] text-neutral-400">avg</span>
      </div>
    </div>
  );
}
