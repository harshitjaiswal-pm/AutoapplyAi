"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";

/**
 * Small completeness badge that lives in the navbar. Polls
 * /api/user/profile/completeness on mount and shows "X% ready". Clicks
 * through to /onboarding or surfaces a tooltip listing missing fields.
 *
 * Hidden when no user is signed in. Hidden when completeness is 100%
 * (no point in nagging — keep the navbar clean).
 *
 * Why polled (not pushed): the worker writes nothing to the profile;
 * only the user does, through the onboarding/profile pages. Re-fetch on
 * mount catches the new state on the next page navigation, which is fine
 * — this isn't a real-time signal.
 */
interface CompletenessResponse {
  percent: number;
  meetsGate: boolean;
  earned: number;
  totalWeight: number;
  missing: Array<{ label: string; weight: number; reason?: string }>;
}

export function ProfileCompletenessBadge() {
  const { status } = useSession();
  const [data, setData] = useState<CompletenessResponse | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/user/profile/completeness");
        if (!res.ok) return;
        const json = (await res.json()) as CompletenessResponse;
        if (!cancelled) setData(json);
      } catch {
        /* tolerate — badge just doesn't render */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  // No data, no session, or already at 100% → render nothing
  if (!data || data.percent >= 100) return null;

  const color =
    data.percent >= 90
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : data.percent >= 60
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-red-50 text-red-700 border-red-200";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium border ${color} hover:opacity-90 transition-opacity`}
        title="Profile completeness — click to see what's missing"
      >
        <span className="font-mono">{data.percent}%</span>
        <span className="text-[11px] opacity-80">profile</span>
      </button>

      {expanded && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-neutral-200 rounded-lg shadow-lg z-50 p-3">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[13px] font-semibold text-neutral-800">
              Profile {data.percent}% complete
            </div>
            <Link
              href="/onboarding"
              className="text-[11px] text-indigo-600 hover:underline"
              onClick={() => setExpanded(false)}
            >
              Edit →
            </Link>
          </div>
          {data.percent < 90 && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-2">
              Reach 90%+ to enable queueing new applications. Incomplete
              profiles cause the worker to fail at the first wizard step.
            </div>
          )}
          {data.missing.length > 0 ? (
            <ul className="space-y-1">
              {data.missing.map((m, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[12px] text-neutral-700"
                >
                  <span className="text-neutral-400 mt-0.5">○</span>
                  <span className="flex-1">
                    {m.label}
                    {m.reason && (
                      <span className="block text-[11px] text-neutral-500 mt-0.5">
                        {m.reason}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-neutral-400 font-mono">
                    +{m.weight}%
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[12px] text-neutral-500">
              All required fields filled. (You can still add optional ones
              like GitHub, portfolio, pronouns to push to 100%.)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
