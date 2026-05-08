"use client";

import { useEffect, useState } from "react";

interface CostEvent {
  stage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cents: number;
  ts: string;
}

interface CostBreakdownData {
  events: CostEvent[];
  totalCents: number;
  byStage: Record<string, number>;
}

const STAGE_LABELS: Record<string, string> = {
  resume_tailor: "Resume tailoring",
  cover_letter: "Cover letter",
  parse_resume: "Resume parse",
  analyze_job: "JD analysis",
  answer_question: "Form Q&A",
  chat: "Chat",
};

const STAGE_COLORS: Record<string, string> = {
  resume_tailor: "bg-indigo-500",
  cover_letter: "bg-violet-500",
  parse_resume: "bg-blue-500",
  analyze_job: "bg-cyan-500",
  answer_question: "bg-emerald-500",
  chat: "bg-amber-500",
};

/**
 * Per-application cost breakdown card. Renders nothing if there are no
 * cost events recorded (legacy applications from before the analytics
 * shipped, or runs that didn't hit any LLM call).
 */
export default function CostBreakdown({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<CostBreakdownData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/applications/${applicationId}/cost`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: CostBreakdownData) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  if (error || !data || data.events.length === 0) return null;

  // Sort stages by spend desc for the bar
  const sortedStages = Object.entries(data.byStage).sort((a, b) => b[1] - a[1]);

  return (
    <div className="bg-white rounded-2xl border border-neutral-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-neutral-900">Cost breakdown</h2>
        <span className="text-xs text-neutral-500 tabular-nums">
          ${(data.totalCents / 100).toFixed(3)} · {data.events.length} call{data.events.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Stacked bar by stage */}
      <div className="flex h-2 rounded-full overflow-hidden bg-neutral-100 mb-3">
        {sortedStages.map(([stage, cents]) => {
          const pct = data.totalCents > 0 ? (cents / data.totalCents) * 100 : 0;
          return (
            <div
              key={stage}
              className={`${STAGE_COLORS[stage] ?? "bg-neutral-400"} transition-all`}
              style={{ width: `${pct}%` }}
              title={`${STAGE_LABELS[stage] ?? stage}: ${cents.toFixed(2)}¢`}
            />
          );
        })}
      </div>

      {/* Legend with cost per stage */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {sortedStages.map(([stage, cents]) => (
          <div key={stage} className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`inline-block w-2 h-2 rounded-full ${STAGE_COLORS[stage] ?? "bg-neutral-400"}`}
              />
              <span className="text-neutral-700 truncate">{STAGE_LABELS[stage] ?? stage}</span>
            </div>
            <span className="text-neutral-500 tabular-nums whitespace-nowrap">
              {cents.toFixed(2)}¢
            </span>
          </div>
        ))}
      </div>

      {/* Per-call event list — collapsed by default to keep the card compact */}
      <details className="mt-4">
        <summary className="text-[11px] text-neutral-400 cursor-pointer hover:text-neutral-600">
          {data.events.length} individual call{data.events.length === 1 ? "" : "s"} (expand)
        </summary>
        <div className="mt-2 space-y-1.5 max-h-60 overflow-y-auto">
          {data.events.map((ev, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 text-[11px] text-neutral-500 border-l-2 border-neutral-100 pl-2 py-0.5"
            >
              <div className="min-w-0 flex-1 truncate">
                <span className="text-neutral-700 font-medium">
                  {STAGE_LABELS[ev.stage] ?? ev.stage}
                </span>
                <span className="ml-2 text-neutral-400">{ev.model}</span>
              </div>
              <div className="text-right shrink-0 tabular-nums">
                <span className="text-neutral-600">{ev.cents.toFixed(2)}¢</span>
                <span className="text-neutral-300 ml-2">
                  {ev.inputTokens}/{ev.outputTokens}t
                </span>
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
