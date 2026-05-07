"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import type { TenantCredsRow } from "../api/credentials/route";

function formatRelativeDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 14) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export default function CredentialsPage() {
  const [creds, setCreds] = useState<TenantCredsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/credentials")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
        } else {
          setCreds(data.credentials ?? []);
        }
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (host: string) => setRevealed((r) => ({ ...r, [host]: !r[host] }));

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 text-white px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl font-bold">Workday Account Credentials</h1>
          <p className="text-indigo-300 text-sm mt-1 max-w-2xl">
            Every Workday tenant you've created an account on. Use these to
            sign in manually if you need to check application status, withdraw,
            or upload supplemental docs.
          </p>
          <p className="text-amber-300 text-[11px] mt-3 flex items-center gap-1">
            ⚠ These are throwaway passwords for job-application accounts only.
            Don't reuse them anywhere else.
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-4 text-sm">
            {error}
          </div>
        )}

        {creds === null && !error && (
          <div className="text-center py-20 text-neutral-400 text-sm">Loading…</div>
        )}

        {creds && creds.length === 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-10 text-center">
            <p className="text-sm font-semibold text-neutral-700">No accounts yet</p>
            <p className="text-xs text-neutral-400 mt-1 max-w-md mx-auto">
              Run a submission via{" "}
              <code className="bg-neutral-100 px-1.5 py-0.5 rounded">smoke_full_apply.ts</code>{" "}
              and the credentials it creates will appear here.
            </p>
          </div>
        )}

        {creds && creds.length > 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase text-neutral-400 tracking-wider border-b border-neutral-100">
                  <th className="text-left px-5 py-3 font-semibold">Tenant</th>
                  <th className="text-left px-3 py-3 font-semibold">Email</th>
                  <th className="text-left px-3 py-3 font-semibold">Password</th>
                  <th className="text-left px-3 py-3 font-semibold">Created</th>
                  <th className="text-left px-5 py-3 font-semibold">Sign-in</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {creds.map((c) => {
                  const isRevealed = revealed[c.tenantHost] === true;
                  const tenantName = c.tenantHost.split(".")[0];
                  // Workday sign-in URL convention. Most tenants accept
                  // /<tenantPath>/login but the safest universal entry point
                  // is the tenant root, which redirects to login when not
                  // authenticated.
                  const signInUrl = `https://${c.tenantHost}/`;
                  return (
                    <tr key={c.tenantHost} className="hover:bg-neutral-50">
                      <td className="px-5 py-3">
                        <p className="font-medium text-neutral-900">{tenantName}</p>
                        <p className="text-[10px] text-neutral-400">{c.tenantHost}</p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5">
                          <code className="text-xs text-neutral-700 select-text">{c.email}</code>
                          <CopyButton text={c.email} />
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5">
                          <code className="text-xs text-neutral-700 select-text font-mono">
                            {isRevealed ? c.password : "••••••••••••"}
                          </code>
                          <button
                            type="button"
                            onClick={() => toggle(c.tenantHost)}
                            className="text-[11px] text-indigo-600 hover:text-indigo-700 font-medium"
                          >
                            {isRevealed ? "Hide" : "Reveal"}
                          </button>
                          <CopyButton text={c.password} />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-neutral-500 whitespace-nowrap">
                        {formatRelativeDate(c.createdAt)}
                      </td>
                      <td className="px-5 py-3">
                        <a
                          href={signInUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                        >
                          Open portal ↗
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
