"use client";

import { useRouter } from "next/navigation";

export default function SuccessPage() {
  const router = useRouter();

  const openLinkedIn = () => {
    window.open("https://www.linkedin.com/jobs/search/", "_blank");
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center py-16 animate-fade-in">
      <div className="max-w-md mx-auto px-6 text-center space-y-8">
        {/* Icon */}
        <div className="flex flex-col items-center gap-5">
          <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M6 16l7 7 13-13" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="space-y-2">
            <h1 className="text-[30px] font-bold text-neutral-900 tracking-tight">
              You're all set
            </h1>
            <p className="text-[15px] text-neutral-500 leading-relaxed">
              Your profile is saved and the extension is ready. Head to LinkedIn and start applying.
            </p>
          </div>
        </div>

        {/* Quick steps */}
        <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-6 text-left space-y-4">
          <p className="text-[12px] font-semibold text-indigo-600 uppercase tracking-wider">
            Next steps
          </p>
          <div className="space-y-3">
            <Step num="1" text="Go to LinkedIn Jobs and search for roles you want." />
            <Step num="2" text="Click the AutoApply panel on the right — hit Scan Page." />
            <Step num="3" text="Select jobs, click Start Applying, and let it run." />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3">
          <button
            onClick={openLinkedIn}
            className="w-full bg-indigo-600 text-white font-semibold py-3.5 rounded-xl hover:bg-indigo-700 active:bg-indigo-800 transition-colors shadow-md shadow-indigo-200"
          >
            Start on LinkedIn Jobs →
          </button>
          <button
            onClick={() => router.push("/dashboard")}
            className="w-full text-neutral-500 font-medium py-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition-colors text-[14px]"
          >
            View dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ num, text }: { num: string; text: string }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="w-5 h-5 rounded-full bg-indigo-200 text-indigo-700 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
        {num}
      </div>
      <p className="text-[13px] text-neutral-700 leading-relaxed">{text}</p>
    </div>
  );
}
