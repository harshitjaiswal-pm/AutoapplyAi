"use client";

import { useState } from "react";
import { useAppStore } from "@/store/useAppStore";

/**
 * Helper: Download a file from the export API.
 * Calls /api/export-resume with the resume data and desired format,
 * then triggers a browser download of the resulting file.
 */
async function downloadResume(
  resume: any,
  format: "pdf" | "docx",
  setExporting: (val: string) => void
) {
  setExporting(format);
  try {
    const response = await fetch("/api/export-resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume, format }),
    });

    if (!response.ok) {
      alert("Export failed. Please try again.");
      return;
    }

    // Convert the response to a downloadable blob
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tailored_resume.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  } catch {
    alert("Download failed. Make sure the dev server is running.");
  } finally {
    setExporting("");
  }
}

/**
 * TailorEngine — The "Go" button that triggers the magic.
 *
 * Once the user has:
 * 1. Parsed their resume (Step 1)
 * 2. Analyzed a job description (Step 2)
 *
 * This component sends both to the tailoring API and displays the result:
 * - Match score (how well the resume fits the job)
 * - What the AI changed and why
 * - The full tailored resume
 * - A cover letter
 */
export default function TailorEngine() {
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");

  const {
    parsedResume,
    parsedJob,
    tailoredResult,
    isTailoring,
    setTailoredResult,
    setIsTailoring,
    addApplication,
  } = useAppStore();

  // Can't tailor without both pieces
  const canTailor = parsedResume && parsedJob && !isTailoring;

  const handleTailor = async () => {
    if (!parsedResume || !parsedJob) return;

    setError("");
    setIsTailoring(true);

    try {
      const response = await fetch("/api/tailor-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsedResume, parsedJob }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Tailoring failed.");
        return;
      }

      setTailoredResult(data.tailoredResult);

      // Auto-add to application tracker
      addApplication({
        id: Date.now().toString(),
        jobTitle: parsedJob.title,
        company: parsedJob.company || "Unknown",
        status: "matched",
        appliedAt: new Date().toISOString(),
        resumeVersion: `Tailored - ${parsedJob.title}`,
        matchScore: data.tailoredResult.matchScore,
      });
    } catch {
      setError("Network error. Make sure the dev server is running.");
    } finally {
      setIsTailoring(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Tailor button */}
      <div className="bg-gray-50 rounded-xl p-6 border border-gray-200">
        <h2 className="text-xl font-semibold text-navy mb-2">
          Step 3: Tailor Your Resume
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          {!parsedResume && !parsedJob
            ? "Complete Steps 1 and 2 first."
            : !parsedResume
            ? "Complete Step 1 first (parse your resume)."
            : !parsedJob
            ? "Complete Step 2 first (analyze the job)."
            : "Ready! Click below to tailor your resume for this job."}
        </p>

        <button
          onClick={handleTailor}
          disabled={!canTailor}
          className="bg-navy hover:bg-navy/90 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold px-8 py-4 rounded-lg text-lg transition-colors w-full"
        >
          {isTailoring ? (
            <span className="flex items-center justify-center gap-3">
              <span className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              AI is tailoring your resume... (15-30 seconds)
            </span>
          ) : (
            "Tailor My Resume"
          )}
        </button>

        {error && (
          <p className="mt-3 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
            {error}
          </p>
        )}
      </div>

      {/* Results */}
      {tailoredResult && (
        <div className="space-y-6">
          {/* Match Score with Breakdown */}
          <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-navy">Match Score</h3>
              <div
                className={`text-3xl font-bold ${
                  tailoredResult.matchScore >= 80
                    ? "text-green-600"
                    : tailoredResult.matchScore >= 60
                    ? "text-yellow-600"
                    : "text-red-600"
                }`}
              >
                {tailoredResult.matchScore}/100
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              {tailoredResult.matchReasoning}
            </p>

            {/* Score Breakdown — shows exactly how points were calculated */}
            {tailoredResult.matchBreakdown && (
              <div className="border-t border-gray-100 pt-4 space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Score Breakdown
                </p>
                {Object.entries(tailoredResult.matchBreakdown).map(
                  ([key, val]: [string, any]) => (
                    <div key={key} className="flex items-center gap-3 text-sm">
                      <div className="w-36 text-gray-500 capitalize text-xs">
                        {key.replace(/([A-Z])/g, " $1").trim()}
                      </div>
                      <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            val.max
                              ? val.score / val.max >= 0.7
                                ? "bg-green-500"
                                : val.score / val.max >= 0.4
                                ? "bg-yellow-500"
                                : "bg-red-500"
                              : val.score < 0
                              ? "bg-red-500"
                              : "bg-gray-300"
                          }`}
                          style={{
                            width: val.max
                              ? `${(val.score / val.max) * 100}%`
                              : "0%",
                          }}
                        />
                      </div>
                      <div className="w-16 text-right text-xs font-mono text-gray-600">
                        {val.score}/{val.max || 0}
                      </div>
                      <div className="w-48 text-xs text-gray-400 truncate" title={val.detail}>
                        {val.detail}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          {/* Changes Made */}
          <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold text-navy mb-3">
              What the AI Changed
            </h3>
            <ul className="space-y-2">
              {tailoredResult.changes.map((change, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="text-brand-500 mt-0.5 font-bold">
                    &rarr;
                  </span>
                  <span className="text-gray-700">{change}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Tailored Resume Preview + Download */}
          <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-navy">
                Tailored Resume
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    downloadResume(
                      tailoredResult.tailoredResume,
                      "pdf",
                      setExporting
                    )
                  }
                  disabled={!!exporting}
                  className="text-sm bg-red-600 hover:bg-red-700 disabled:bg-gray-300 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {exporting === "pdf" ? (
                    <>
                      <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                      Exporting...
                    </>
                  ) : (
                    "Download PDF"
                  )}
                </button>
                <button
                  onClick={() =>
                    downloadResume(
                      tailoredResult.tailoredResume,
                      "docx",
                      setExporting
                    )
                  }
                  disabled={!!exporting}
                  className="text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {exporting === "docx" ? (
                    <>
                      <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                      Exporting...
                    </>
                  ) : (
                    "Download Word"
                  )}
                </button>
                <button
                  onClick={() => {
                    const resume = tailoredResult.tailoredResume;
                    const text = formatResumeAsText(resume);
                    navigator.clipboard.writeText(text);
                    alert("Resume copied to clipboard!");
                  }}
                  className="text-sm bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-lg transition-colors"
                >
                  Copy Text
                </button>
              </div>
            </div>
            <ResumePreview resume={tailoredResult.tailoredResume} />
          </div>

          {/* Cover Letter */}
          <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-navy">Cover Letter</h3>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(tailoredResult.coverLetter);
                  alert("Cover letter copied to clipboard!");
                }}
                className="text-sm bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 rounded-lg transition-colors"
              >
                Copy to Clipboard
              </button>
            </div>
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {tailoredResult.coverLetter}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ResumePreview — Displays the tailored resume in a readable format.
 * This renders the structured resume data as formatted text.
 */
function ResumePreview({
  resume,
}: {
  resume: NonNullable<ReturnType<typeof useAppStore.getState>["parsedResume"]>;
}) {
  if (!resume) return null;

  return (
    <div className="text-sm space-y-4">
      {/* Contact */}
      <div className="text-center border-b border-gray-200 pb-3">
        <p className="text-lg font-bold text-navy">
          {resume.contactInfo.name}
        </p>
        <p className="text-gray-600">
          {[
            resume.contactInfo.email,
            resume.contactInfo.phone,
            resume.contactInfo.location,
          ]
            .filter(Boolean)
            .join(" | ")}
        </p>
        {(resume.contactInfo.linkedin || resume.contactInfo.portfolio) && (
          <p className="text-gray-500">
            {[resume.contactInfo.linkedin, resume.contactInfo.portfolio]
              .filter(Boolean)
              .join(" | ")}
          </p>
        )}
      </div>

      {/* Summary */}
      {resume.summary && (
        <div>
          <p className="font-bold text-navy uppercase text-xs tracking-wider mb-1">
            Professional Summary
          </p>
          <p className="text-gray-700">{resume.summary}</p>
        </div>
      )}

      {/* Skills */}
      <div>
        <p className="font-bold text-navy uppercase text-xs tracking-wider mb-1">
          Skills
        </p>
        <div className="text-gray-700">
          {resume.skills.technical.length > 0 && (
            <p>
              <strong>Technical:</strong>{" "}
              {resume.skills.technical.join(", ")}
            </p>
          )}
          {resume.skills.tools.length > 0 && (
            <p>
              <strong>Tools:</strong> {resume.skills.tools.join(", ")}
            </p>
          )}
          {resume.skills.soft.length > 0 && (
            <p>
              <strong>Soft Skills:</strong> {resume.skills.soft.join(", ")}
            </p>
          )}
        </div>
      </div>

      {/* Experience */}
      {resume.experience.length > 0 && (
        <div>
          <p className="font-bold text-navy uppercase text-xs tracking-wider mb-2">
            Experience
          </p>
          {resume.experience.map((exp, i) => (
            <div key={i} className="mb-3">
              <div className="flex justify-between">
                <p className="font-semibold text-gray-800">{exp.role}</p>
                <p className="text-gray-500 text-xs">
                  {exp.startDate} - {exp.endDate}
                </p>
              </div>
              <p className="text-gray-600 text-xs">{exp.company}</p>
              <ul className="mt-1 space-y-0.5">
                {exp.bullets.map((bullet, j) => (
                  <li key={j} className="text-gray-700 pl-3 relative">
                    <span className="absolute left-0 top-0">&#8226;</span>
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Education */}
      {resume.education.length > 0 && (
        <div>
          <p className="font-bold text-navy uppercase text-xs tracking-wider mb-1">
            Education
          </p>
          {resume.education.map((edu, i) => (
            <div key={i} className="flex justify-between">
              <div>
                <p className="font-semibold text-gray-800">{edu.degree}</p>
                <p className="text-gray-600 text-xs">{edu.school}</p>
              </div>
              <p className="text-gray-500 text-xs">{edu.year}</p>
            </div>
          ))}
        </div>
      )}

      {/* Projects */}
      {resume.projects.length > 0 && (
        <div>
          <p className="font-bold text-navy uppercase text-xs tracking-wider mb-1">
            Projects
          </p>
          {resume.projects.map((proj, i) => (
            <div key={i} className="mb-2">
              <p className="font-semibold text-gray-800">{proj.name}</p>
              <p className="text-gray-700 text-xs">{proj.description}</p>
              <p className="text-gray-500 text-xs">
                Tech: {proj.technologies.join(", ")}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Helper: Convert structured resume back to plain text.
 * Used for the "Copy to Clipboard" feature.
 */
function formatResumeAsText(
  resume: NonNullable<ReturnType<typeof useAppStore.getState>["parsedResume"]>
): string {
  const lines: string[] = [];

  lines.push(resume.contactInfo.name);
  lines.push(
    [
      resume.contactInfo.email,
      resume.contactInfo.phone,
      resume.contactInfo.location,
    ]
      .filter(Boolean)
      .join(" | ")
  );
  if (resume.contactInfo.linkedin) lines.push(resume.contactInfo.linkedin);
  lines.push("");

  if (resume.summary) {
    lines.push("PROFESSIONAL SUMMARY");
    lines.push(resume.summary);
    lines.push("");
  }

  lines.push("SKILLS");
  if (resume.skills.technical.length)
    lines.push(`Technical: ${resume.skills.technical.join(", ")}`);
  if (resume.skills.tools.length)
    lines.push(`Tools: ${resume.skills.tools.join(", ")}`);
  if (resume.skills.soft.length)
    lines.push(`Soft Skills: ${resume.skills.soft.join(", ")}`);
  lines.push("");

  if (resume.experience.length) {
    lines.push("EXPERIENCE");
    for (const exp of resume.experience) {
      lines.push(`${exp.role} | ${exp.company} | ${exp.startDate} - ${exp.endDate}`);
      for (const bullet of exp.bullets) {
        lines.push(`  - ${bullet}`);
      }
      lines.push("");
    }
  }

  if (resume.education.length) {
    lines.push("EDUCATION");
    for (const edu of resume.education) {
      lines.push(`${edu.degree} - ${edu.school} (${edu.year})`);
    }
    lines.push("");
  }

  if (resume.projects.length) {
    lines.push("PROJECTS");
    for (const proj of resume.projects) {
      lines.push(`${proj.name}: ${proj.description}`);
      lines.push(`  Technologies: ${proj.technologies.join(", ")}`);
    }
  }

  return lines.join("\n");
}
