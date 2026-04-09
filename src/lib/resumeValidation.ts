import { ParsedResume } from "@/store/useAppStore";

export interface ValidationWarning {
  field: string;
  sourceValue: string;
  tailoredValue: string;
  severity: "error" | "warning";
  message: string;
}

export interface ResumeValidationResult {
  sourceYears: number;
  tailoredYears: number;
  warnings: ValidationWarning[];
  hasDefects: boolean;
}

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  // [AutoQA fix 2026-04-09] Check for "Present"/"Current" in ANY segment of the range
  // BEFORE stripping. Previously, the code split and took [0] first, which meant that
  // an endDate like "Jan 2018 – Present" or "2018 – Present" would parse as Jan 2018
  // instead of the current date, silently under-counting experience years.
  // Checking all parts first ensures range strings with a "Present" endpoint always
  // return the current date, matching the caller's intent for endDate fields.
  const presentWords = new Set(["present", "current", "now", "today"]);
  const rangeParts = dateStr.split(/\s*[–—-]\s*/);
  if (rangeParts.some((p) => presentWords.has(p.trim().toLowerCase()))) {
    return new Date();
  }

  // Strip em-dash / en-dash / hyphen ranges — take only the first segment if it's a range
  // e.g. "Jan 2018 – Dec 2020" → "Jan 2018"
  const stripped = rangeParts[0].trim();
  const lower = stripped.toLowerCase().trim();

  // "Month. Year" — abbreviated with trailing period e.g. "Jan. 2020", "Feb. 2018"
  // Also handles "Month Year", "Month, Year"
  const monthYearMatch = lower.match(/([a-z]+)\.?[,\s]+(\d{4})/);
  if (monthYearMatch) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const monthIdx = months.findIndex((m) => monthYearMatch[1].replace(/\.$/, "").startsWith(m));
    if (monthIdx >= 0) {
      return new Date(parseInt(monthYearMatch[2]), monthIdx, 1);
    }
  }

  // "MM/YYYY" — e.g. "08/2019", "01/2022"
  const mmYYYYMatch = lower.match(/^(\d{1,2})\/(\d{4})$/);
  if (mmYYYYMatch) {
    return new Date(parseInt(mmYYYYMatch[2]), parseInt(mmYYYYMatch[1]) - 1, 1);
  }

  // "YYYY/MM" — e.g. "2019/08"
  const yyyyMMSlashMatch = lower.match(/^(\d{4})\/(\d{2})$/);
  if (yyyyMMSlashMatch) {
    return new Date(parseInt(yyyyMMSlashMatch[1]), parseInt(yyyyMMSlashMatch[2]) - 1, 1);
  }

  // "YYYY-MM" ISO partial — e.g. "2020-01"
  const isoMatch = lower.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, 1);
  }

  // "Q1/Q2/Q3/Q4 YYYY" — e.g. "Q1 2022", "Q3 2019"
  const quarterMatch = lower.match(/q([1-4])\s*(\d{4})/);
  if (quarterMatch) {
    const monthForQ = (parseInt(quarterMatch[1]) - 1) * 3; // Q1→0, Q2→3, Q3→6, Q4→9
    return new Date(parseInt(quarterMatch[2]), monthForQ, 1);
  }

  // "Summer/Fall/Spring/Winter YYYY" — use midpoint months
  const seasonMatch = lower.match(/(summer|fall|autumn|spring|winter)\s*(\d{4})/);
  if (seasonMatch) {
    const seasonMonth: Record<string, number> = {
      spring: 2, summer: 6, fall: 9, autumn: 9, winter: 11,
    };
    return new Date(parseInt(seasonMatch[2]), seasonMonth[seasonMatch[1]] ?? 6, 1);
  }

  // Just a year "2020"
  const yearMatch = lower.match(/^(\d{4})$/);
  if (yearMatch) {
    return new Date(parseInt(yearMatch[1]), 0, 1);
  }

  // Fallback: try native Date parse
  const native = new Date(dateStr);
  if (!isNaN(native.getTime())) return native;

  return null;
}

/** Calculate total years of experience from a list of roles (non-overlapping sum). */
export function calcExperienceYears(experience: ParsedResume["experience"]): number {
  let totalMonths = 0;
  for (const exp of experience) {
    const start = parseDate(exp.startDate);
    const end = parseDate(exp.endDate);
    if (start && end && end >= start) {
      const months =
        (end.getFullYear() - start.getFullYear()) * 12 +
        (end.getMonth() - start.getMonth());
      totalMonths += Math.max(0, months);
    }
  }
  return Math.round((totalMonths / 12) * 10) / 10;
}

/** Full validation of a tailored resume vs. the source resume. */
export function validateTailoredResume(
  source: ParsedResume,
  tailored: ParsedResume
): ResumeValidationResult {
  const warnings: ValidationWarning[] = [];

  const sourceYears = calcExperienceYears(source.experience);
  const tailoredYears = calcExperienceYears(tailored.experience);
  const discrepancyYears = sourceYears - tailoredYears;

  // ── Experience years dropped ──────────────────────────────────────────────
  if (sourceYears > 0 && tailoredYears > 0) {
    const pctDrop = sourceYears > 0 ? discrepancyYears / sourceYears : 0;
    if (discrepancyYears > 1 || pctDrop > 0.15) {
      warnings.push({
        field: "totalExperienceYears",
        sourceValue: `${sourceYears}y`,
        tailoredValue: `${tailoredYears}y`,
        severity: discrepancyYears > 2 ? "error" : "warning",
        message: `Experience dropped from ${sourceYears}y → ${tailoredYears}y (−${discrepancyYears.toFixed(1)}y). Verify dates were not accidentally shortened.`,
      });
    }
  }

  // ── Roles removed ─────────────────────────────────────────────────────────
  const sourceCo = source.experience.length;
  const tailoredCo = tailored.experience.length;
  if (sourceCo > tailoredCo) {
    warnings.push({
      field: "experienceCount",
      sourceValue: `${sourceCo} roles`,
      tailoredValue: `${tailoredCo} roles`,
      severity: "warning",
      message: `${sourceCo - tailoredCo} role(s) were removed during tailoring. Confirm this was intentional.`,
    });
  }

  // ── Name integrity ────────────────────────────────────────────────────────
  if (
    source.contactInfo.name &&
    tailored.contactInfo.name &&
    source.contactInfo.name.trim().toLowerCase() !==
      tailored.contactInfo.name.trim().toLowerCase()
  ) {
    warnings.push({
      field: "name",
      sourceValue: source.contactInfo.name,
      tailoredValue: tailored.contactInfo.name,
      severity: "error",
      message: `Name changed: "${source.contactInfo.name}" → "${tailored.contactInfo.name}".`,
    });
  }

  // ── Email integrity ───────────────────────────────────────────────────────
  if (
    source.contactInfo.email &&
    tailored.contactInfo.email &&
    source.contactInfo.email.trim().toLowerCase() !==
      tailored.contactInfo.email.trim().toLowerCase()
  ) {
    warnings.push({
      field: "email",
      sourceValue: source.contactInfo.email,
      tailoredValue: tailored.contactInfo.email,
      severity: "error",
      message: `Email changed: "${source.contactInfo.email}" → "${tailored.contactInfo.email}".`,
    });
  }

  // ── Bullet count sanity (flagrant hallucination indicator) ────────────────
  const sourceBullets = source.experience.reduce((n, e) => n + e.bullets.length, 0);
  const tailoredBullets = tailored.experience.reduce((n, e) => n + e.bullets.length, 0);
  if (sourceBullets > 0 && tailoredBullets > sourceBullets * 2) {
    warnings.push({
      field: "bulletCount",
      sourceValue: `${sourceBullets} bullets`,
      tailoredValue: `${tailoredBullets} bullets`,
      severity: "warning",
      message: `Bullet count jumped from ${sourceBullets} → ${tailoredBullets}. AI may have hallucinated extra experience bullets.`,
    });
  }

  const hasDefects = warnings.length > 0;

  return {
    sourceYears,
    tailoredYears,
    warnings,
    hasDefects,
  };
}
