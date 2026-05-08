"use client";

import { useEffect, useState } from "react";

interface BudgetStatus {
  spendCents: number;
  capCents: number;
  remainingCents: number;
  isOver: boolean;
  monthKey: string;
}

/**
 * Compact monthly-budget pill for the dashboard. Polls /api/budget on
 * mount + every 60s. Color codes:
 *   - <70% spent: indigo (normal)
 *   - 70-99%: amber (approaching cap)
 *   - 100%+: red (over cap; new applications will be refused at enqueue)
 */
export default function BudgetWidget() {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/budget");
        if (!res.ok) {
          if (!cancelled) setError(res.status === 401 ? null : `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as BudgetStatus;
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error || !status) return null;

  const pct = status.capCents > 0 ? Math.min(100, (status.spendCents / status.capCents) * 100) : 0;
  const tier = status.isOver ? "over" : pct >= 70 ? "warn" : "ok";

  const colors: Record<typeof tier, { bar: string; bg: string; text: string }> = {
    ok: { bar: "bg-indigo-400", bg: "bg-white/8", text: "text-indigo-200" },
    warn: { bar: "bg-amber-300", bg: "bg-amber-500/15", text: "text-amber-200" },
    over: { bar: "bg-red-400", bg: "bg-red-500/20", text: "text-red-200" },
  };
  const c = colors[tier];

  return (
    <div className={`rounded-xl backdrop-blur px-4 py-3 mt-3 ${c.bg}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-1.5">
            <p className="text-[10px] text-indigo-300 font-semibold uppercase tracking-wider">
              Anthropic budget · {status.monthKey}
            </p>
            <p className={`text-[11px] ${c.text} font-medium tabular-nums`}>
              ${(status.spendCents / 100).toFixed(2)} / ${(status.capCents / 100).toFixed(2)}
            </p>
          </div>
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full ${c.bar} transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {status.isOver && (
          <div className="text-[11px] text-red-200 font-medium whitespace-nowrap">
            New applications blocked
          </div>
        )}
      </div>
    </div>
  );
}
