"use client";

import { CopyButton } from "./CopyButton";

interface ContactInfo {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  portfolio?: string;
}

interface ExperienceEntry {
  company?: string;
  role?: string;
  title?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  bullets?: string[];
}

interface EducationEntry {
  school?: string;
  degree?: string;
  year?: string;
  startDate?: string;
  endDate?: string;
  gpa?: string;
}

interface Skills {
  technical?: string[];
  soft?: string[];
  tools?: string[];
}

interface ProjectEntry {
  name?: string;
  description?: string;
  technologies?: string[];
}

interface ParsedResume {
  contactInfo?: ContactInfo;
  summary?: string;
  skills?: Skills | string[] | unknown;
  experience?: ExperienceEntry[];
  education?: EducationEntry[];
  projects?: ProjectEntry[];
  certifications?: string[];
}

/** Convert the parsedResume JSON into a single plaintext block — used for the
 *  "Copy entire resume" button. Preserves the structure so a recruiter can
 *  paste it into an email or doc and read it without rendering. */
function resumeToPlainText(r: ParsedResume): string {
  const lines: string[] = [];
  if (r.contactInfo?.name) lines.push(r.contactInfo.name);
  const contact = [r.contactInfo?.email, r.contactInfo?.phone, r.contactInfo?.location]
    .filter(Boolean)
    .join(" · ");
  if (contact) lines.push(contact);
  if (r.contactInfo?.linkedin) lines.push(r.contactInfo.linkedin);
  if (r.contactInfo?.portfolio) lines.push(r.contactInfo.portfolio);
  lines.push("");
  if (r.summary) {
    lines.push("SUMMARY");
    lines.push(r.summary);
    lines.push("");
  }
  if (r.experience && r.experience.length) {
    lines.push("EXPERIENCE");
    for (const e of r.experience) {
      const dates = [e.startDate, e.endDate].filter(Boolean).join(" – ");
      const headline = `${e.role || e.title || ""} — ${e.company || ""}${dates ? `  (${dates})` : ""}`;
      lines.push(headline.trim());
      for (const b of e.bullets || []) lines.push(`  • ${b}`);
      lines.push("");
    }
  }
  if (r.education && r.education.length) {
    lines.push("EDUCATION");
    for (const ed of r.education) {
      const dates = ed.year || [ed.startDate, ed.endDate].filter(Boolean).join(" – ");
      lines.push(`${ed.degree || ""} — ${ed.school || ""}${dates ? `  (${dates})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function flattenSkills(skills: unknown): { label: string; items: string[] }[] {
  if (!skills) return [];
  if (Array.isArray(skills)) {
    return [{ label: "Skills", items: skills.filter((s) => typeof s === "string") }];
  }
  if (typeof skills === "object") {
    const s = skills as Record<string, unknown>;
    const out: { label: string; items: string[] }[] = [];
    for (const [key, val] of Object.entries(s)) {
      if (Array.isArray(val) && val.length > 0) {
        out.push({
          label: key.charAt(0).toUpperCase() + key.slice(1),
          items: val.filter((v) => typeof v === "string"),
        });
      }
    }
    return out;
  }
  return [];
}

export function TailoredResumeView({ resume }: { resume: Record<string, unknown> }) {
  const r = resume as ParsedResume;
  const skills = flattenSkills(r.skills);
  const fullText = resumeToPlainText(r);

  return (
    <div className="space-y-5 text-sm">
      {/* Contact header */}
      {r.contactInfo && (
        <div className="border-b border-neutral-100 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              {r.contactInfo.name && (
                <p className="text-lg font-bold text-neutral-900">{r.contactInfo.name}</p>
              )}
              <p className="text-xs text-neutral-500 mt-1 flex flex-wrap gap-x-2 gap-y-0.5 select-text">
                {r.contactInfo.email && <span>{r.contactInfo.email}</span>}
                {r.contactInfo.phone && <span>· {r.contactInfo.phone}</span>}
                {r.contactInfo.location && <span>· {r.contactInfo.location}</span>}
              </p>
              {(r.contactInfo.linkedin || r.contactInfo.portfolio) && (
                <p className="text-[11px] text-indigo-600 mt-0.5 flex flex-wrap gap-x-2 select-text">
                  {r.contactInfo.linkedin && <span>{r.contactInfo.linkedin}</span>}
                  {r.contactInfo.portfolio && <span>{r.contactInfo.portfolio}</span>}
                </p>
              )}
            </div>
            <CopyButton text={fullText} label="Copy full resume" />
          </div>
        </div>
      )}

      {/* Summary */}
      {r.summary && (
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Summary</h3>
            <CopyButton text={r.summary} />
          </div>
          <p className="text-neutral-700 leading-relaxed whitespace-pre-wrap select-text">{r.summary}</p>
        </section>
      )}

      {/* Skills */}
      {skills.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">Skills</h3>
          <div className="space-y-1.5">
            {skills.map((group) => (
              <div key={group.label}>
                <span className="text-[11px] font-medium text-neutral-500 mr-2">{group.label}:</span>
                <span className="text-xs text-neutral-700 select-text">{group.items.join(", ")}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Experience */}
      {r.experience && r.experience.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">Experience</h3>
          <div className="space-y-4">
            {r.experience.map((e, i) => {
              const headline = `${e.role || e.title || ""} — ${e.company || ""}`;
              const dates = [e.startDate, e.endDate].filter(Boolean).join(" – ");
              const bulletText = (e.bullets || []).map((b) => `• ${b}`).join("\n");
              const blockText = `${headline}${dates ? `  (${dates})` : ""}\n${bulletText}`;
              return (
                <div key={i}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-neutral-900 select-text">{headline}</p>
                      {dates && <p className="text-[11px] text-neutral-400 mt-0.5">{dates}</p>}
                    </div>
                    <CopyButton text={blockText} />
                  </div>
                  {e.bullets && e.bullets.length > 0 && (
                    <ul className="mt-1.5 space-y-1 ml-4 list-disc marker:text-neutral-300">
                      {e.bullets.map((b, j) => (
                        <li key={j} className="text-xs text-neutral-700 leading-relaxed select-text">{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Education */}
      {r.education && r.education.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">Education</h3>
          <div className="space-y-2">
            {r.education.map((ed, i) => {
              const dates = ed.year || [ed.startDate, ed.endDate].filter(Boolean).join(" – ");
              return (
                <div key={i}>
                  <p className="font-semibold text-neutral-900 select-text">{ed.degree || ""}</p>
                  <p className="text-xs text-neutral-500 select-text">
                    {ed.school || ""}{dates ? ` · ${dates}` : ""}{ed.gpa ? ` · GPA ${ed.gpa}` : ""}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Projects */}
      {r.projects && r.projects.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">Projects</h3>
          <div className="space-y-2">
            {r.projects.map((p, i) => (
              <div key={i}>
                <p className="font-semibold text-neutral-900 select-text">{p.name}</p>
                {p.description && <p className="text-xs text-neutral-700 mt-0.5 select-text">{p.description}</p>}
                {p.technologies && p.technologies.length > 0 && (
                  <p className="text-[11px] text-neutral-400 mt-0.5">{p.technologies.join(", ")}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Certifications */}
      {r.certifications && r.certifications.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">Certifications</h3>
          <ul className="space-y-1 ml-4 list-disc marker:text-neutral-300">
            {r.certifications.map((c, i) => (
              <li key={i} className="text-xs text-neutral-700 select-text">{c}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
