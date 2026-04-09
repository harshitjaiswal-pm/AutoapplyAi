"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SuccessPage() {
  const router = useRouter();

  const openLinkedIn = () => {
    window.open("https://www.linkedin.com/jobs/search/", "_blank");
  };

  return (
    <div className="min-h-screen bg-white py-16">
      <div className="max-w-2xl mx-auto px-6 text-center space-y-12">
        {/* Celebration */}
        <div className="space-y-6">
          <div className="text-6xl mb-4">🎉</div>
          <h1 className="text-4xl font-bold text-neutral-900">
            You're all set!
          </h1>
          <p className="text-lg text-neutral-500 max-w-md mx-auto">
            Your profile is ready and your Chrome extension is installed. Time
            to start applying!
          </p>
        </div>

        {/* Next steps */}
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-8 space-y-6">
          <h2 className="text-xl font-semibold text-neutral-900">
            Here's how to start applying to jobs:
          </h2>

          <div className="space-y-4 text-left">
            <StepCard
              number="1"
              icon="🔗"
              title="Go to LinkedIn Jobs"
              desc="Start browsing job listings on LinkedIn"
              action={
                <button
                  onClick={openLinkedIn}
                  className="text-indigo-600 font-medium text-sm hover:text-indigo-700"
                >
                  Open LinkedIn Jobs →
                </button>
              }
            />

            <StepCard
              number="2"
              icon="🔍"
              title="Click 'Scan Page'"
              desc="The AutoApply AI panel will appear on the right side. Click 'Scan Page' to extract jobs."
            />

            <StepCard
              number="3"
              icon="✅"
              title="Select & Apply"
              desc="Choose which jobs to apply to, then click 'Start Applying' to let AI handle the rest."
            />
          </div>
        </div>

        {/* Dashboard link */}
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => router.push("/dashboard")}
            className="bg-indigo-600 text-white font-medium px-6 py-3 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            View Dashboard →
          </button>
          <button
            onClick={openLinkedIn}
            className="border border-neutral-200 text-neutral-700 font-medium px-6 py-3 rounded-lg hover:bg-neutral-50 transition-colors"
          >
            Open LinkedIn
          </button>
        </div>

        {/* Footer text */}
        <p className="text-[13px] text-neutral-500 max-w-md mx-auto">
          Need help? Your profile is saved and synced with the extension. You
          can update it anytime from your dashboard.
        </p>
      </div>
    </div>
  );
}

function StepCard({
  number,
  icon,
  title,
  desc,
  action,
}: {
  number: string;
  icon: string;
  title: string;
  desc: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex items-start">
        <div className="w-10 h-10 rounded-full bg-indigo-200 text-indigo-700 font-bold flex items-center justify-center shrink-0">
          {number}
        </div>
      </div>
      <div className="flex-1 text-left">
        <p className="font-semibold text-neutral-900 flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          {title}
        </p>
        <p className="text-[13px] text-neutral-600 mt-1">{desc}</p>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}
