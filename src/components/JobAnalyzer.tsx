"use client";

import { useState, useEffect, useRef } from "react";
import { useAppStore } from "@/store/useAppStore";

export default function JobAnalyzer() {
  const [jobText, setJobText] = useState("");
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { parsedJob, isAnalyzingJob, setParsedJob, setIsAnalyzingJob } =
    useAppStore();

  // Sync browser-restored textarea value with React state on mount
  useEffect(() => {
    if (textareaRef.current && textareaRef.current.value && !jobText) {
      setJobText(textareaRef.current.value);
    }
  }, []);

  const handleAnalyze = async () => {
    if (jobText.trim().length < 50) {
      setError("Paste the full job description.");
      return;
    }
    setError("");
    setIsAnalyzingJob(true);
    try {
      const res = await fetch("/api/analyze-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jobText }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Something went wrong."); return; }
      setParsedJob(data.parsedJob);
    } catch {
      setError("Network error. Is the dev server running?");
    } finally {
      setIsAnalyzingJob(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-semibold text-violet-400">02</span>
          <h2 className="text-sm font-semibold text-neutral-900">Job description</h2>
        </div>
        <p className="text-[13px] text-neutral-400 mt-0.5 ml-7">
          Paste the job posting you want to target
        </p>
      </div>

      <textarea
        ref={textareaRef}
        className="w-full h-48 p-4 bg-neutral-50 border border-neutral-200 rounded-lg text-sm font-mono text-neutral-700 placeholder:text-neutral-300 focus:outline-none focus:ring-1 focus:ring-indigo-200 focus:border-indigo-200 resize-y transition-all"
        placeholder="Paste the job description here..."
        value={jobText}
        onChange={(e) => setJobText(e.target.value)}
        autoComplete="off"
      />

      {error && (
        <p className="text-[13px] text-red-500 animate-fade-in">{error}</p>
      )}

      <button
        onClick={handleAnalyze}
        disabled={isAnalyzingJob || jobText.trim().length < 50}
        className="text-sm font-medium bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed transition-colors"
      >
        {isAnalyzingJob ? (
          <span className="flex items-center gap-2">
            <span className="animate-spin h-3 w-3 border-[1.5px] border-white border-t-transparent rounded-full" />
            Analyzing...
          </span>
        ) : (
          "Analyze job"
        )}
      </button>

      {parsedJob && (
        <div className="border border-neutral-200 rounded-lg p-4 animate-fade-up space-y-4">
          <div>
            <p className="text-sm font-semibold text-neutral-900">
              {parsedJob.title}
              {parsedJob.company && (
                <span className="font-normal text-neutral-400"> at {parsedJob.company}</span>
              )}
            </p>
            <p className="text-[13px] text-neutral-400">{parsedJob.yearsExperience} experience</p>
          </div>

          <TagGroup label="Required" tags={parsedJob.requiredSkills} color="red" />
          {parsedJob.preferredSkills.length > 0 && (
            <TagGroup label="Preferred" tags={parsedJob.preferredSkills} color="amber" />
          )}
          <TagGroup label="ATS keywords" tags={parsedJob.keywords} color="neutral" />
        </div>
      )}
    </div>
  );
}

function TagGroup({
  label,
  tags,
  color,
}: {
  label: string;
  tags: string[];
  color: "red" | "amber" | "neutral";
}) {
  const styles = {
    red: "bg-red-50 text-red-600 border-red-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
    neutral: "bg-neutral-100 text-neutral-600 border-neutral-200",
  };
  return (
    <div>
      <p className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mb-1.5">
        {label}
      </p>
      <div className="flex flex-wrap gap-1">
        {tags.map((tag, i) => (
          <span
            key={i}
            className={`text-[12px] px-2 py-0.5 rounded-md border ${styles[color]}`}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}
