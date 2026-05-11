"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleJob, ConsoleJobState } from "@/lib/console";

type Tab = "captured" | "pipeline" | "archived";

const TAB_TITLES: Record<Tab, string> = {
  captured: "Captured",
  pipeline: "Pipeline",
  archived: "Archived",
};

const STATE_BADGE: Record<ConsoleJobState, string> = {
  captured: "bg-neutral-100 text-neutral-700",
  queued: "bg-indigo-100 text-indigo-700",
  running: "bg-blue-100 text-blue-700",
  submitted: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  archived: "bg-neutral-200 text-neutral-500",
};

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - d) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.round(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ConsolePage() {
  const [jobs, setJobs] = useState<ConsoleJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("captured");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pasteUrl, setPasteUrl] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState<{ ids: string[] } | null>(null);

  // LinkedIn pull state
  const [pullOpen, setPullOpen] = useState(false);
  const [pullKeywords, setPullKeywords] = useState("Senior Product Manager");
  const [pullLocation, setPullLocation] = useState("Canada");
  const [pullRemote, setPullRemote] = useState(true);
  const [dailyQuota, setDailyQuota] = useState<{ used: number; remaining: number; capCount: number } | null>(null);

  // Refresh quota periodically and after captures land. Cheap GET — fine to
  // poll while the captured tab is open since it's the surface that shows it.
  const loadQuota = useCallback(async () => {
    try {
      const res = await fetch("/api/console/daily-quota");
      if (res.ok) {
        const data = await res.json();
        setDailyQuota({ used: data.used, remaining: data.remaining, capCount: data.capCount });
      }
    } catch { /* tolerate */ }
  }, []);

  useEffect(() => {
    loadQuota();
    const t = setInterval(loadQuota, 15000);
    return () => clearInterval(t);
  }, [loadQuota]);

  const triggerLinkedInPull = () => {
    const keywords = pullKeywords.trim();
    const loc = pullLocation.trim();
    if (!keywords || !loc) {
      setError("Title and location are required for LinkedIn pull.");
      return;
    }
    // Build LinkedIn search URL — f_WT=2 = Remote, f_TPR=r604800 =
    // past week (recent listings only).
    const params = new URLSearchParams();
    params.set("keywords", keywords);
    params.set("location", loc);
    params.set("f_TPR", "r604800");
    if (pullRemote) params.set("f_WT", "2");
    const linkedinUrl = `https://www.linkedin.com/jobs/search/?${params.toString()}`;
    const consoleUrl = window.location.origin + "/console";
    const cfg = { keywords, location: loc, remote: pullRemote, count: 25, consoleUrl };

    // Hand the trigger to pipeline-bridge.js (a content script running on
    // this page in the extension's isolated world). It writes the config
    // into chrome.storage.local, where linkedin-pull.js can read it on
    // the next LinkedIn page load. We can't write chrome.storage directly
    // from page-side JS — content scripts are sandboxed away from us.
    window.postMessage({ __aa_trigger: "linkedin_pull", cfg }, "*");

    // Open LinkedIn synchronously so the new tab is created inside the
    // user's click gesture (avoids Chrome's popup blocker). The bridge's
    // storage write is fast — linkedin-pull.js polls a few times after
    // its 2s render delay, so a slight race is tolerated.
    setPullOpen(false);
    window.open(linkedinUrl, "_blank");
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/console/jobs");
      if (!res.ok) {
        if (res.status === 401) setError("Sign in to use the Console.");
        else setError(`Load failed: ${res.status}`);
        return;
      }
      const data = (await res.json()) as { jobs: ConsoleJob[] };
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Pipeline AND Captured tabs poll every 5s. Pipeline gets live worker
  // status; Captured picks up newly-scraped LinkedIn rows that
  // pipeline-bridge.js POSTs after the user's tab redirects back from
  // a LinkedIn pull. Without this, the user has to hard-refresh the
  // page to see fresh captures — race between the page mount fetch
  // and the bridge's POSTs.
  useEffect(() => {
    if (tab !== "captured" && tab !== "pipeline") return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [tab, load]);

  const filtered = useMemo(() => {
    if (!jobs) return [];
    switch (tab) {
      case "captured":
        return jobs
          .filter((j) => j.state === "captured")
          .sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
      case "pipeline":
        // Pipeline = ACTIVE work only. Finished jobs (failed or submitted)
        // belong on the Submissions page where the user can dive into the
        // detail page, see the tailored resume + credentials, and either
        // manually drive them or retry. Showing them here previously
        // turned Pipeline into a graveyard of failed rows the user
        // couldn't act on usefully. Changed 2026-05-11.
        return jobs.filter((j) => j.state === "queued" || j.state === "running");
      case "archived":
        return jobs.filter((j) => j.state === "archived");
      default:
        return [];
    }
  }, [jobs, tab]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { captured: 0, pipeline: 0, archived: 0 };
    if (!jobs) return c;
    for (const j of jobs) {
      if (j.state === "captured") c.captured++;
      else if (j.state === "archived") c.archived++;
      else if (j.state === "queued" || j.state === "running") c.pipeline++;
      // failed + submitted no longer count toward Pipeline — they live
      // on /applications (Submissions page) post 2026-05-11 refactor.
    }
    return c;
  }, [jobs]);

  const allSelected = filtered.length > 0 && filtered.every((j) => selected.has(j.id));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map((j) => j.id)));
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePaste = async () => {
    const url = pasteUrl.trim();
    if (!url) return;
    setBusyAction("paste");
    try {
      const res = await fetch("/api/console/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, source: "paste" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || `Add failed: ${res.status}`);
      } else {
        setPasteUrl("");
        await load();
      }
    } finally {
      setBusyAction(null);
    }
  };

  const requestApplySelected = () => {
    if (selected.size === 0) return;
    setConfirmApply({ ids: Array.from(selected) });
  };

  const performApply = async () => {
    if (!confirmApply) return;
    setBusyAction("apply");
    try {
      const res = await fetch("/api/console/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: confirmApply.ids }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || `Enqueue failed: ${res.status}`);
      } else {
        setSelected(new Set());
        setTab("pipeline");
        await load();
      }
    } finally {
      setBusyAction(null);
      setConfirmApply(null);
    }
  };

  const handleArchive = async (id: string) => {
    setBusyAction(`archive:${id}`);
    try {
      await fetch(`/api/console/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive: true }),
      });
      await load();
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequeue = async (id: string) => {
    setBusyAction(`requeue:${id}`);
    try {
      const res = await fetch("/api/console/requeue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || `Re-queue failed: ${res.status}`);
      } else {
        await load();
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleUnarchive = async (id: string) => {
    setBusyAction(`unarchive:${id}`);
    try {
      await fetch(`/api/console/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unarchive: true }),
      });
      await load();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-neutral-900">Console</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Capture jobs, pick what to apply for, ship to the worker pipeline.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-neutral-200 mb-4">
        {(Object.keys(TAB_TITLES) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setSelected(new Set());
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-indigo-600 text-indigo-700"
                : "border-transparent text-neutral-500 hover:text-neutral-900"
            }`}
          >
            {TAB_TITLES[t]} <span className="text-neutral-400 ml-1">{counts[t]}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Add-by-URL bar (Captured tab only) */}
      {tab === "captured" && (
        <div className="flex gap-2 mb-3">
          <input
            type="url"
            value={pasteUrl}
            onChange={(e) => setPasteUrl(e.target.value)}
            placeholder="Paste a Workday/Greenhouse/Lever job URL"
            className="flex-1 px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:border-indigo-400"
            onKeyDown={(e) => e.key === "Enter" && handlePaste()}
          />
          <button
            onClick={handlePaste}
            disabled={!pasteUrl.trim() || busyAction === "paste"}
            className="px-4 py-2 text-sm font-medium bg-neutral-900 text-white rounded-lg hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      )}

      {/* LinkedIn bulk-pull bar (Captured tab only) */}
      {tab === "captured" && (
        <div className="mb-4 px-4 py-3 bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 rounded-lg">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-indigo-900">Pull jobs from LinkedIn</p>
              <p className="text-xs text-indigo-700 mt-0.5">
                Scrape up to 25 fresh listings from a LinkedIn search. Easy Apply jobs are skipped — only external ATS listings get queued.
                {dailyQuota && (
                  <span className="ml-2 font-medium">
                    {dailyQuota.remaining} of {dailyQuota.capCount} captures left today.
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={() => setPullOpen(!pullOpen)}
              className="shrink-0 px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              {pullOpen ? "Cancel" : "Pull from LinkedIn"}
            </button>
          </div>

          {pullOpen && (
            <div className="mt-3 pt-3 border-t border-indigo-200 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label className="block text-[10px] font-semibold text-indigo-700 uppercase tracking-wider mb-1">Title</label>
                <input
                  type="text"
                  value={pullKeywords}
                  onChange={(e) => setPullKeywords(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-indigo-200 rounded-md focus:outline-none focus:border-indigo-500 bg-white"
                  placeholder="Senior Product Manager"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-indigo-700 uppercase tracking-wider mb-1">Location</label>
                <input
                  type="text"
                  value={pullLocation}
                  onChange={(e) => setPullLocation(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-indigo-200 rounded-md focus:outline-none focus:border-indigo-500 bg-white"
                  placeholder="Canada"
                />
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-sm text-indigo-900 cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    checked={pullRemote}
                    onChange={(e) => setPullRemote(e.target.checked)}
                    className="w-4 h-4"
                  />
                  Remote only
                </label>
                <button
                  onClick={triggerLinkedInPull}
                  disabled={!pullKeywords.trim() || !pullLocation.trim() || (dailyQuota?.remaining ?? 100) <= 0}
                  className="px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Open LinkedIn
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bulk action bar (Captured tab only) */}
      {tab === "captured" && selected.size > 0 && (
        <div className="flex items-center justify-between mb-3 px-4 py-2 bg-indigo-50 border border-indigo-100 rounded-lg">
          <span className="text-sm text-indigo-900 font-medium">
            {selected.size} selected
          </span>
          <button
            onClick={requestApplySelected}
            disabled={busyAction === "apply"}
            className="px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40"
          >
            Apply selected ({selected.size})
          </button>
        </div>
      )}

      {/* Table */}
      {jobs === null ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div className="border border-neutral-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left">
              <tr className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                {tab === "captured" && (
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  </th>
                )}
                {tab === "captured" && <th className="px-3 py-2 w-16">Match</th>}
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">ATS</th>
                {tab !== "captured" && <th className="px-3 py-2">State</th>}
                <th className="px-3 py-2">Captured</th>
                <th className="px-3 py-2 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => (
                <tr key={j.id} className="border-t border-neutral-100 hover:bg-neutral-50">
                  {tab === "captured" && (
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(j.id)}
                        onChange={() => toggleOne(j.id)}
                      />
                    </td>
                  )}
                  {tab === "captured" && (
                    <td className="px-3 py-2.5 font-medium text-neutral-700">
                      {typeof j.matchScore === "number" ? `${j.matchScore}%` : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2.5 font-medium text-neutral-900">{j.company}</td>
                  <td className="px-3 py-2.5 text-neutral-700">
                    <a href={j.url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-700 hover:underline">
                      {j.title}
                    </a>
                    {j.sources.length > 1 && (
                      <span className="ml-2 text-[11px] text-neutral-400">seen {j.sources.length}x</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-neutral-500">{j.location || "—"}</td>
                  <td className="px-3 py-2.5 text-neutral-500 capitalize">{j.ats}</td>
                  {tab !== "captured" && (
                    <td className="px-3 py-2.5">
                      <span className={`inline-block px-2 py-0.5 text-[11px] font-medium rounded ${STATE_BADGE[j.state]}`}>
                        {j.state}
                        {j.queueLane === "retry" && " (retry)"}
                      </span>
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-neutral-500">{relativeTime(j.capturedAt)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <RowActions
                      job={j}
                      tab={tab}
                      busyAction={busyAction}
                      onArchive={() => handleArchive(j.id)}
                      onUnarchive={() => handleUnarchive(j.id)}
                      onRequeue={() => handleRequeue(j.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirm dialog */}
      {confirmApply && (
        <ApplyConfirmModal
          count={confirmApply.ids.length}
          onCancel={() => setConfirmApply(null)}
          onConfirm={performApply}
          busy={busyAction === "apply"}
        />
      )}
    </div>
  );
}

function RowActions({
  job,
  tab,
  busyAction,
  onArchive,
  onUnarchive,
  onRequeue,
}: {
  job: ConsoleJob;
  tab: Tab;
  busyAction: string | null;
  onArchive: () => void;
  onUnarchive: () => void;
  onRequeue: () => void;
}) {
  if (tab === "captured") {
    return (
      <button
        onClick={onArchive}
        disabled={busyAction === `archive:${job.id}`}
        className="text-xs text-neutral-500 hover:text-neutral-900"
      >
        Archive
      </button>
    );
  }
  if (tab === "archived") {
    return (
      <button
        onClick={onUnarchive}
        disabled={busyAction === `unarchive:${job.id}`}
        className="text-xs text-neutral-500 hover:text-neutral-900"
      >
        Unarchive
      </button>
    );
  }
  // pipeline tab
  if (job.state === "failed") {
    return (
      <button
        onClick={onRequeue}
        disabled={busyAction === `requeue:${job.id}`}
        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
      >
        Re-queue
      </button>
    );
  }
  if (job.state === "submitted" && job.applicationId) {
    return (
      <a
        href={`/applications/${job.applicationId}`}
        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
      >
        Review →
      </a>
    );
  }
  return <span className="text-xs text-neutral-400">—</span>;
}

function EmptyState({ tab }: { tab: Tab }) {
  return (
    <div className="border border-dashed border-neutral-200 rounded-lg p-12 text-center">
      <p className="text-sm text-neutral-500">
        {tab === "captured" && "No captured jobs yet. Paste a URL above, or send jobs from the Chrome extension."}
        {tab === "pipeline" && (
          <>
            Nothing in flight. Apply to a captured job to start.
            <br />
            <span className="text-[12px] text-neutral-400">
              Finished jobs (submitted + failed) live on the{" "}
              <a href="/applications" className="text-indigo-600 hover:underline">
                Submissions page
              </a>
              .
            </span>
          </>
        )}
        {tab === "archived" && "No archived jobs."}
      </p>
    </div>
  );
}

function ApplyConfirmModal({
  count,
  onCancel,
  onConfirm,
  busy,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  // Match the dispatcher's actual concurrency (set via MAX_PARALLEL_JOBS
  // env on Railway, default 1). Was hardcoded "2" pre-2026-05-08 when
  // we lowered to 1 for Railway's Hobby tier — copy drifted from reality.
  const PARALLEL = 1;
  const willRun = Math.min(count, PARALLEL);
  const willQueue = Math.max(0, count - PARALLEL);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-neutral-900 mb-2">Apply to {count} jobs?</h2>
        <p className="text-sm text-neutral-600 mb-4">
          {willRun} will run now, {willQueue} will queue. The worker runs {PARALLEL} application{PARALLEL === 1 ? "" : "s"} in parallel; the rest are picked up as slots free up. Failed jobs can be re-queued individually.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? "Queuing…" : `Apply to ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
