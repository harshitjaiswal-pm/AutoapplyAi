/**
 * buildResumeFilename — shared logic for naming tailored resume exports.
 *
 * Used by:
 *   - TailorEngine.tsx (client-side download)
 *   - /api/build-filename (server endpoint so external tools — e.g. the
 *     linkedin-apply Cowork skill — can match the exact convention)
 *
 * Format: "<INITIALS>_<Company>_<RoleAbbrev>"
 *   Example: Kiran Shahi → Veeva Systems Inc → Senior Business Analyst
 *            → "KS_Veeva_SBA"
 *
 * Rules:
 *   - INITIALS: first letter of first 2–3 name tokens, A-Z only. Falls back
 *     to "Resume" when name is empty.
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

  const initials = (applicantName || "").trim()
    ? (applicantName as string)
        .trim()
        .split(/\s+/)
        .slice(0, 3)
        .map((w) => w.charAt(0))
        .join("")
        .toUpperCase()
        .replace(/[^A-Z]/g, "") || "Resume"
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

  const parts = [initials, companyPart, roleAbbrev].filter(Boolean);
  return parts.join("_") || "tailored_resume";
}
