"use client";

import { useState } from "react";

interface ApprovalButtonsProps {
  applicationId: string;
  /** Called after a successful approve/reject so the parent can refetch. */
  onChange?: () => void;
}

/**
 * Green "Approve & Submit" / red "Reject" pair shown on the application
 * detail page when reviewStatus === "awaiting_review". Clicking either
 * POSTs to /api/applications/[id]/{approve,reject} and triggers a parent
 * refresh. The buttons disable themselves while the request is in flight
 * to prevent double-clicks during the round-trip.
 */
export default function ApprovalButtons({ applicationId, onChange }: ApprovalButtonsProps) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (action: "approve" | "reject") => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${applicationId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "reject" ? JSON.stringify({}) : undefined,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || `Request failed: ${res.status}`);
        setBusy(null);
        return;
      }
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-2xl p-5">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">Review tailored resume before submission</p>
          <p className="text-xs text-amber-800 mt-1">
            The worker has tailored the resume below and is waiting for your approval before
            uploading it to the company and clicking Submit. Reject means nothing goes to the
            recruiter.
          </p>
          {error && (
            <p className="text-xs text-red-700 mt-2 font-mono">{error}</p>
          )}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <button
            type="button"
            onClick={() => submit("approve")}
            disabled={busy !== null}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors min-w-[160px]"
          >
            {busy === "approve" ? "Approving…" : "Approve & Submit"}
          </button>
          <button
            type="button"
            onClick={() => submit("reject")}
            disabled={busy !== null}
            className="bg-white hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed text-red-700 border border-red-300 text-sm font-semibold px-4 py-2 rounded-lg transition-colors min-w-[160px]"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}
