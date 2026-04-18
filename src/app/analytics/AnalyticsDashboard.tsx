"use client";

import { useEffect, useState, useCallback } from "react";
import FunnelWidget from "./components/FunnelWidget";
import ChannelBreakdownWidget from "./components/ChannelBreakdownWidget";
import AtsMatrixWidget from "./components/AtsMatrixWidget";
import ResponseCohortsWidget from "./components/ResponseCohortsWidget";
import MatchCalibrationWidget from "./components/MatchCalibrationWidget";
import KeywordGapWidget from "./components/KeywordGapWidget";
import EffortOutcomeWidget from "./components/EffortOutcomeWidget";
import FailureLogWidget from "./components/FailureLogWidget";
import PipelineWidget from "./components/PipelineWidget";

type Range = "7d" | "30d" | "all";

interface DashboardData {
  funnel:            { stages: any[]; note?: string };
  channelBreakdown:  any[];
  atsMatrix:         any[];
  responseCohorts:   any[];
  matchCalibration:  any[];
  keywordGaps:       any[];
  effortOutcome:     any;
  failureLog:        any[];
  pipeline:          any[];
  duplicatesBlocked: number;
  dataRange:         string;
  generatedAt:       string;
}

export default function AnalyticsDashboard() {
  const [range, setRange]     = useState<Range>("30d");
  const [data, setData]       = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchData = useCallback(async (r: Range) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/summary?range=${r}`);
      if (\!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(range); }, [range, fetchData]);

  const handleStageChange = async (jobId: string, fromStage: string, toStage: string) => {
    await fetch("/api/pipeline/stage", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jobId, fromStage, toStage }),
    });
    fetchData(range);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        Loading analytics…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-500 text-sm">
        Failed to load analytics: {error}
      </div>
    );
  }

  if (\!data) return null;

  return (
    <div className="max-w-7xl mx-auto py-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Application Analytics</h1>
          <p className="text-sm text-gray-500 mt-1">
            Data from {data.dataRange} · refreshed {new Date(data.generatedAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="flex rounded-md border border-gray-200 overflow-hidden text-sm">
          {(["7d", "30d", "all"] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-4 py-2 ${range === r ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              {r === "7d" ? "7 days" : r === "30d" ? "30 days" : "All time"}
            </button>
          ))}
        </div>
      </div>

      {/* Dedup notice */}
      {data.duplicatesBlocked > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <strong>{data.duplicatesBlocked}</strong> duplicate application{data.duplicatesBlocked \!== 1 ? "s" : ""} blocked this period.
        </div>
      )}

      {/* A. Funnel */}
      <FunnelWidget
        stages={data.funnel.stages}
        note={data.funnel.note}
        dateRange={range}
        onDateRangeChange={setRange}
        onStageClick={(stage) => console.log("Drill into:", stage)}
      />

      {/* B. Channel Breakdown */}
      <ChannelBreakdownWidget channels={data.channelBreakdown} />

      {/* C. ATS Matrix */}
      <AtsMatrixWidget data={data.atsMatrix} />

      {/* D + E side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ResponseCohortsWidget cohorts={data.responseCohorts} />
        <MatchCalibrationWidget data={data.matchCalibration} />
      </div>

      {/* F + G side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <KeywordGapWidget keywordGaps={data.keywordGaps} />
        <EffortOutcomeWidget effortOutcome={data.effortOutcome} />
      </div>

      {/* H. Failure Log */}
      <FailureLogWidget failureLog={data.failureLog} />

      {/* I. Pipeline */}
      <PipelineWidget pipeline={data.pipeline} onStageChange={handleStageChange} />
    </div>
  );
}
