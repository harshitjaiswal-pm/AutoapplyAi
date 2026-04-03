"use client";

import { useState } from "react";
import { useAppStore } from "@/store/useAppStore";

async function downloadResume(
  resume: any,
  format: "pdf" | "docx",
  setExporting: (v: string) => void
) {
  setExporting(format);
  try {
    const res = await fetch("/api/export-resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume, format }),
    });
    if (!res.ok) { alert("Export failed."); return; }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tailored_resume.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  } catch {
    alert("Download failed.");
  } finally {
    setExporting("");
  }
}

/* Category display names + colors */
const CATEGORY_META: Record<string, { label: string; color: string }> = {
  requiredSkills: { label: "Required Skills", color: "bg-rose-50 text-rose-600 border-rose-100" },
  experienceLevel: { label: "Experience", color: "bg-blue-50 text-blue-600 border-blue-100" },
  industryMatch: { label: "Industry", color: "bg-amber-50 text-amber-600 border-amber-100" },
  preferredSkills: { label: "Preferred Skills", color: "bg-violet-50 text-violet-600 border-violet-100" },
  education: { label: "Education", color: "bg-emerald-50 text-emerald-600 border-emerald-100" },
  redFlags: { label: "Red Flags", color: "bg-orange-50 text-orange-600 border-orange-100" },
};

export default function TailorEngine() {
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");
  const [copied, setCopied] = useState("");
  const [tab, setTab] = useState<"resume" | "cover">("resume");

  const {
    parsedResume,
    parsedJob,
    tailoredResult,
    isTailoring,
    setTailoredResult,
    setIsTailoring,
    addApplication,
  } = useAppStore();

  const canTailor = parsedResume && parsedJob && !isTailoring;

  const handleTailor = async () => {
    if (!parsedResume || !parsedJob) return;
    setError("");
    setIsTailoring(true);
    try {
      const res = await fetch("/api/tailor-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parsedResume, parsedJob }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Tailoring failed."); return; }
      setTailoredResult(data.tailoredResult);
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
      setError("Network error.");
    } finally {
      setIsTailoring(false);
    }
  };

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 2000);
  };

  // Group changes by category
  const groupedChanges: Record<string, string[]> = {};
  if (tailoredResult) {
    for (const c of tailoredResult.changes) {
      // Handle both old string[] format and new {category, text} format
      const cat = typeof c === "string" ? "general" : c.category;
      const txt = typeof c === "string" ? c : c.text;
      if (!groupedChanges[cat]) groupedChanges[cat] = [];
      groupedChanges[cat].push(txt);
    }
  }

  return (
    <div className="space-y-6">
      {/* CTA */}
      <div className="border border-neutral-200 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono font-semibold text-purple-400">03</span>
          <h2 className="text-sm font-semibold text-neutral-900">Tailor</h2>
        </div>
        <p className="text-[13px] text-neutral-400 mb-4 ml-7">
          {!parsedResume && !parsedJob
            ? "Complete steps 1 and 2 first."
            : !parsedResume
            ? "Parse your resume first."
            : !parsedJob
            ? "Analyze the job first."
            : "Ready. This takes about 15-30 seconds."}
        </p>
        <button
          onClick={handleTailor}
          disabled={!canTailor}
          className="w-full bg-indigo-600 text-white font-medium py-3 rounded-lg hover:bg-indigo-700 disabled:bg-neutral-100 disabled:text-neutral-400 disabled:cursor-not-allowed transition-colors text-sm"
        >
          {isTailoring ? (
            <span className="flex items-center justify-center gap-2">
              <span className="animate-spin h-3.5 w-3.5 border-[1.5px] border-white border-t-transparent rounded-full" />
              Tailoring...
            </span>
          ) : (
            "Tailor my resume"
          )}
        </button>
        {error && (
          <p className="text-[13px] text-red-500 mt-3 animate-fade-in">{error}</p>
        )}
      </div>

      {/* ═══ Results: Side-by-side ═══ */}
      {tailoredResult && (
        <div className="animate-fade-up">
          {/* Score header */}
          <div className="border border-neutral-200 rounded-xl p-6 mb-6">
            <div className="flex items-start justify-between gap-6">
              <div className="flex-1">
                <p className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mb-2">Match analysis</p>
                <p className="text-sm text-neutral-500 leading-relaxed">{tailoredResult.matchReasoning}</p>
              </div>
              <div className="text-right shrink-0">
                <p className={`text-3xl font-bold tabular-nums ${
                  tailoredResult.matchScore >= 70 ? "text-emerald-600"
                    : tailoredResult.matchScore >= 55 ? "text-amber-500"
                    : "text-red-500"
                }`}>{tailoredResult.matchScore}</p>
                <p className="text-[11px] text-neutral-400">/ 100</p>
              </div>
            </div>
          </div>

          {/* Two-column layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* LEFT: Score breakdown + changes per category */}
            <div className="space-y-4">
              <p className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                Score breakdown &amp; improvements
              </p>

              {tailoredResult.matchBreakdown &&
                Object.entries(tailoredResult.matchBreakdown).map(
                  ([key, val]: [string, any]) => {
                    const meta = CATEGORY_META[key] || { label: key, color: "bg-neutral-50 text-neutral-600 border-neutral-200" };
                    const changes = groupedChanges[key] || [];
                    const pct = val.max ? Math.max((val.score / val.max) * 100, 0) : 0;

                    return (
                      <div
                        key={key}
                        className="border border-neutral-200 rounded-lg p-4 space-y-2"
                      >
                        {/* Category header + score bar */}
                        <div className="flex items-center justify-between">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${meta.color}`}>
                            {meta.label}
                          </span>
                          <span className="text-[12px] font-mono text-neutral-400">
                            {val.score}/{val.max || 0}
                          </span>
                        </div>
                        <div className="bg-neutral-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              val.max
                                ? pct >= 70 ? "bg-emerald-500"
                                  : pct >= 40 ? "bg-amber-400"
                                  : "bg-red-400"
                                : "bg-neutral-300"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="text-[12px] text-neutral-500 leading-relaxed">
                          {val.detail}
                        </p>

                        {/* Changes that address this gap */}
                        {changes.length > 0 && (
                          <div className="border-t border-neutral-100 pt-2 mt-2 space-y-1.5">
                            <p className="text-[11px] font-medium text-emerald-600 uppercase tracking-wider">
                              Improvements made
                            </p>
                            {changes.map((text, i) => (
                              <div key={i} className="flex items-start gap-2 text-[12px] text-neutral-600">
                                <span className="text-emerald-400 mt-0.5 shrink-0">+</span>
                                {text}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }
                )}

              {/* Any uncategorized changes */}
              {groupedChanges["general"] && groupedChanges["general"].length > 0 && (
                <div className="border border-neutral-200 rounded-lg p-4 space-y-1.5">
                  <p className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider mb-1">Other changes</p>
                  {groupedChanges["general"].map((text, i) => (
                    <div key={i} className="flex items-start gap-2 text-[12px] text-neutral-600">
                      <span className="text-indigo-400 mt-0.5 shrink-0">&rarr;</span>
                      {text}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* RIGHT: Resume / Cover Letter */}
            <div className="border border-neutral-200 rounded-xl overflow-hidden">
              {/* Tabs */}
              <div className="flex border-b border-neutral-200">
                <button
                  onClick={() => setTab("resume")}
                  className={`flex-1 text-[13px] font-medium py-2.5 text-center transition-colors ${
                    tab === "resume"
                      ? "text-indigo-600 bg-indigo-50/50"
                      : "text-neutral-400 hover:text-neutral-600"
                  }`}
                >
                  Resume
                </button>
                <button
                  onClick={() => setTab("cover")}
                  className={`flex-1 text-[13px] font-medium py-2.5 text-center transition-colors border-l border-neutral-200 ${
                    tab === "cover"
                      ? "text-indigo-600 bg-indigo-50/50"
                      : "text-neutral-400 hover:text-neutral-600"
                  }`}
                >
                  Cover letter
                </button>
              </div>

              <div className="p-5">
                {tab === "resume" ? (
                  <>
                    <div className="flex items-center gap-2 mb-4">
                      <SmallBtn
                        onClick={() => downloadResume(tailoredResult.tailoredResume, "pdf", setExporting)}
                        disabled={!!exporting}
                        loading={exporting === "pdf"}
                        label="PDF"
                      />
                      <SmallBtn
                        onClick={() => downloadResume(tailoredResult.tailoredResume, "docx", setExporting)}
                        disabled={!!exporting}
                        loading={exporting === "docx"}
                        label="Word"
                      />
                      <button
                        onClick={() => copy(formatResumeAsText(tailoredResult.tailoredResume), "resume")}
                        className="text-[12px] text-neutral-500 hover:text-neutral-900 px-2.5 py-1.5 rounded-md border border-neutral-200 hover:border-neutral-300 transition-colors"
                      >
                        {copied === "resume" ? "Copied" : "Copy text"}
                      </button>
                    </div>
                    <ResumePreview resume={tailoredResult.tailoredResume} />
                  </>
                ) : (
                  <>
                    <div className="flex justify-end mb-4">
                      <button
                        onClick={() => copy(tailoredResult.coverLetter, "cover")}
                        className="text-[12px] text-neutral-500 hover:text-neutral-900 px-2.5 py-1.5 rounded-md border border-neutral-200 hover:border-neutral-300 transition-colors"
                      >
                        {copied === "cover" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div className="text-sm text-neutral-600 whitespace-pre-wrap leading-relaxed">
                      {tailoredResult.coverLetter}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Small components ── */

function SmallBtn({
  onClick,
  disabled,
  loading,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-[12px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-neutral-200 disabled:text-neutral-400 px-3 py-1.5 rounded-md transition-colors inline-flex items-center gap-1.5"
    >
      {loading ? (
        <span className="animate-spin h-3 w-3 border-[1.5px] border-white border-t-transparent rounded-full" />
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
      )}
      {label}
    </button>
  );
}

function ResumePreview({
  resume,
}: {
  resume: NonNullable<ReturnType<typeof useAppStore.getState>["parsedResume"]>;
}) {
  if (!resume) return null;

  return (
    <div className="text-[13px] space-y-5 bg-neutral-50 border border-neutral-200 rounded-lg p-5 max-h-[70vh] overflow-y-auto">
      {/* Header */}
      <div className="text-center pb-4 border-b border-neutral-200">
        <p className="text-base font-semibold text-neutral-900">{resume.contactInfo.name}</p>
        <p className="text-neutral-500 mt-0.5 text-[12px]">
          {[resume.contactInfo.email, resume.contactInfo.phone, resume.contactInfo.location]
            .filter(Boolean).join("  ·  ")}
        </p>
        {(resume.contactInfo.linkedin || resume.contactInfo.portfolio) && (
          <p className="text-neutral-400 text-[12px] mt-0.5">
            {[resume.contactInfo.linkedin, resume.contactInfo.portfolio]
              .filter(Boolean).join("  ·  ")}
          </p>
        )}
        {resume.contactInfo.authorization && (
          <p className="text-indigo-500 text-[12px] mt-0.5 font-medium">
            {resume.contactInfo.authorization}
          </p>
        )}
      </div>

      {resume.summary && (
        <Section title="Summary">
          <p className="text-neutral-600 leading-relaxed">{resume.summary}</p>
        </Section>
      )}

      <Section title="Skills">
        <div className="space-y-1 text-neutral-600">
          {resume.skills.technical.length > 0 && (
            <p><span className="text-neutral-900 font-medium">Technical:</span> {resume.skills.technical.join(", ")}</p>
          )}
          {resume.skills.tools.length > 0 && (
            <p><span className="text-neutral-900 font-medium">Tools:</span> {resume.skills.tools.join(", ")}</p>
          )}
          {resume.skills.soft.length > 0 && (
            <p><span className="text-neutral-900 font-medium">Soft:</span> {resume.skills.soft.join(", ")}</p>
          )}
        </div>
      </Section>

      {resume.experience.length > 0 && (
        <Section title="Experience">
          <div className="space-y-4">
            {resume.experience.map((exp, i) => (
              <div key={i}>
                <div className="flex justify-between items-baseline">
                  <p className="font-medium text-neutral-900">{exp.role}</p>
                  <p className="text-[11px] text-neutral-400 shrink-0 ml-4">{exp.startDate} – {exp.endDate}</p>
                </div>
                <p className="text-[12px] text-neutral-400">
                  {exp.company}
                  {exp.location && <span> · {exp.location}</span>}
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {exp.bullets.map((b, j) => (
                    <li key={j} className="text-neutral-600 pl-3 relative leading-relaxed">
                      <span className="absolute left-0 top-0 text-neutral-300">·</span>
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {resume.education.length > 0 && (
        <Section title="Education">
          {resume.education.map((edu, i) => (
            <div key={i} className="flex justify-between items-baseline">
              <div>
                <p className="font-medium text-neutral-900">{edu.degree}</p>
                <p className="text-[12px] text-neutral-400">{edu.school}</p>
              </div>
              <p className="text-[11px] text-neutral-400 shrink-0 ml-4">{edu.year}</p>
            </div>
          ))}
        </Section>
      )}

      {resume.projects.length > 0 && (
        <Section title="Projects">
          <div className="space-y-2">
            {resume.projects.map((p, i) => (
              <div key={i}>
                <p className="font-medium text-neutral-900">{p.name}</p>
                <p className="text-neutral-500 text-[12px] leading-relaxed">{p.description}</p>
                {p.technologies.length > 0 && (
                  <p className="text-[11px] text-neutral-400 mt-0.5">{p.technologies.join(", ")}</p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {resume.certifications && resume.certifications.length > 0 && (
        <Section title="Certifications">
          <p className="text-neutral-600">{resume.certifications.join(", ")}</p>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-indigo-400/70 uppercase tracking-wider mb-2 pb-1 border-b border-indigo-50">
        {title}
      </p>
      {children}
    </div>
  );
}

function formatResumeAsText(
  resume: NonNullable<ReturnType<typeof useAppStore.getState>["parsedResume"]>
): string {
  const l: string[] = [];
  l.push(resume.contactInfo.name);
  l.push([resume.contactInfo.email, resume.contactInfo.phone, resume.contactInfo.location].filter(Boolean).join(" | "));
  if (resume.contactInfo.linkedin) l.push(resume.contactInfo.linkedin);
  if (resume.contactInfo.authorization) l.push(resume.contactInfo.authorization);
  l.push("");
  if (resume.summary) { l.push("PROFESSIONAL SUMMARY"); l.push(resume.summary); l.push(""); }
  l.push("SKILLS");
  if (resume.skills.technical.length) l.push(`Technical: ${resume.skills.technical.join(", ")}`);
  if (resume.skills.tools.length) l.push(`Tools: ${resume.skills.tools.join(", ")}`);
  if (resume.skills.soft.length) l.push(`Soft Skills: ${resume.skills.soft.join(", ")}`);
  l.push("");
  if (resume.experience.length) {
    l.push("EXPERIENCE");
    for (const e of resume.experience) {
      const loc = e.location ? ` | ${e.location}` : "";
      l.push(`${e.role} | ${e.company}${loc} | ${e.startDate} - ${e.endDate}`);
      for (const b of e.bullets) l.push(`  - ${b}`);
      l.push("");
    }
  }
  if (resume.education.length) {
    l.push("EDUCATION");
    for (const e of resume.education) l.push(`${e.degree} - ${e.school} (${e.year})`);
    l.push("");
  }
  if (resume.projects.length) {
    l.push("PROJECTS");
    for (const p of resume.projects) {
      l.push(`${p.name}: ${p.description}`);
      l.push(`  Technologies: ${p.technologies.join(", ")}`);
    }
  }
  if (resume.certifications && resume.certifications.length) {
    l.push("");
    l.push("CERTIFICATIONS");
    l.push(resume.certifications.join(", "));
  }
  return l.join("\n");
}
