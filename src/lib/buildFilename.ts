/**
 * buildResumeFilename — shared logic for naming tailored resume exports.
 *
 * Used by:
 *   - TailorEngine.tsx (client-side download)
 *   - /api/build-filename (server endpoint so external tools — e.g. the
 *     linkedin-apply Cowork skill — can match the exact convention)
 *   - chrome-extension/background.js (auto-saved sticky-path PDF after
 *     each tailoring) [PR2 fix 2026-05-01: was 'AutoApply_TailoredResume.pdf'
 *     before, recruiters were seeing that generic filename on the resume —
 *     not great. Now matches Harshit's reference convention.]
 *
 * Format: "<LastName>_<Company>_<RoleAbbrev>"
 *   Example: Harshit Jaiswal → Zynga → Product Manager
 *            → "Jaiswal_Zynga_PM"
 *
 * Rules:
 *   - LastName: last whitespace-separated token of the applicant name,
 *     letters only. Falls back to "Resume" when name is empty.
 *   - Company: first alphanumeric token of the company name, sanitized.
 *     "Veeva Systems Inc" → "Veeva". Keeps filenames short and readable.
 *   - RoleAbbrev: first letter of each significant role word (stopwords
 *     filtered). "Senior Business Analyst" → "SBA", "Product Manager" → "PM".
 */

const STOPWORDS = new Set<string>([
  "of", "and", "the", "for", "to", "in", "on", "at", "a", "an",
  "with", "by", "or", "&",
]);

const sanitize = (s: string): string =>
  s.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_").substring(0, 50);

export function buildResumeFilename(opts: {
  applicantName?: string;
  company?: string;
  role?: string;
}): string {
  const { applicantName, company, role } = opts;

  // [PR2 fix 2026-05-01] Switched from initials ("KS") to LastName ("Shahi")
  // so the generated filename matches Harshit's reference convention
  // "Jaiswal_Zynga_PM.pdf" — recruiters see a recognizable name, not "HJ_Zynga_PM".
  const lastName = (applicantName || "").trim()
    ? (() => {
        const tokens = (applicantName as string).trim().split(/\s+/);
        const last = tokens[tokens.length - 1] || "";
        const cleaned = last.replace(/[^A-Za-z]/g, "");
        return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase() : "Resume";
      })()
    : "Resume";

  const companyPart = company
    ? sanitize(company.split(/[\s,.-]+/)[0] || company)
    : "";

  const roleAbbrev = role
    ? role
        .replace(/[^a-zA-Z\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w && !STOPWORDS.has(w.toLowerCase()))
        .slice(0, 5)
        .map((w) => w.charAt(0).toUpperCase())
        .join("")
    : "";

  const parts = [lastName, companyPart, roleAbbrev].filter(Boolean);
  return parts.join("_") || "tailored_resume";
}
