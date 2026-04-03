"use client";

import { useState } from "react";
import { useAppStore } from "@/store/useAppStore";

/**
 * JobAnalyzer — Lets users paste a job description and analyze it.
 *
 * The analysis extracts:
 * - Required vs preferred skills
 * - ATS keywords (important for getting past automated filters)
 * - Company culture signals
 * - Years of experience expected
 *
 * This structured data is what powers the tailoring engine.
 */
export default function JobAnalyzer() {
  const [jobText, setJobText] = useState("");
  const [error, setError] = useState("");

  const { parsedJob, isAnalyzingJob, setParsedJob, setIsAnalyzingJob } =
    useAppStore();

  const handleAnalyze = async () => {
    if (jobText.trim().length < 50) {
      setError("Please paste the full job description.");
      return;
    }

    setError("");
    setIsAnalyzingJob(true);

    try {
      const response = await fetch("/api/analyze-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jobText }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }

      setParsedJob(data.parsedJob);
    } catch {
      setError("Network error. Make sure the dev server is running.");
    } finally {
      setIsAnalyzingJob(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-navy">
        Step 2: Job Description
      </h2>
      <p className="text-sm text-gray-500">
        Paste the job posting below. The AI will extract requirements, keywords,
        and what the company is really looking for.
      </p>

      <textarea
        className="w-full h-64 p-4 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent resize-y"
        placeholder={`Paste the job description here...

Example:
Senior Product Manager - Analytics Platform

About the role:
We're looking for an experienced PM to lead our analytics product...

Requirements:
- 5+ years of product management experience
- Experience with B2B SaaS products
- Strong SQL skills and data literacy
...`}
        value={jobText}
        onChange={(e) => setJobText(e.target.value)}
      />

      {error && (
        <p className="text-sm text-red-500 bg-red-50 p-3 rounded-lg">
          {error}
        </p>
      )}

      <button
        onClick={handleAnalyze}
        disabled={isAnalyzingJob || jobText.trim().length < 50}
        className="bg-brand-500 hover:bg-brand-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium px-6 py-3 rounded-lg transition-colors"
      >
        {isAnalyzingJob ? (
          <span className="flex items-center gap-2">
            <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            Analyzing with AI...
          </span>
        ) : (
          "Analyze Job"
        )}
      </button>

      {/* Show analyzed result */}
      {parsedJob && (
        <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="font-semibold text-blue-800 mb-3">
            Job Analysis Complete
          </h3>
          <div className="text-sm space-y-3">
            <div>
              <p className="font-medium text-blue-800">
                {parsedJob.title}
                {parsedJob.company ? ` at ${parsedJob.company}` : ""}
              </p>
              <p className="text-blue-600">
                Experience: {parsedJob.yearsExperience}
              </p>
            </div>

            <div>
              <p className="font-medium text-blue-800">Required Skills:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {parsedJob.requiredSkills.map((skill, i) => (
                  <span
                    key={i}
                    className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <p className="font-medium text-blue-800">Preferred Skills:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {parsedJob.preferredSkills.map((skill, i) => (
                  <span
                    key={i}
                    className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded text-xs"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <p className="font-medium text-blue-800">ATS Keywords:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {parsedJob.keywords.map((kw, i) => (
                  <span
                    key={i}
                    className="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
