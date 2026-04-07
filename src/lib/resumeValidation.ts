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
  const lower = dateStr.toLowerCase().trim();

  if (lower === "present" || lower === "current" || lower === "now" || lower === "today") {
    return new Date();
  }

  // "Month Year" or "Month, Year" — e.g. "Jan 2020", "January 2020"
  const monthYearMatch = lower.match(/([a-z]+)[,\s]+(\d{4})/);
  if (monthYearMatch) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const monthIdx = months.findIndex((m) => monthYearMatch[1].startsWith(m));
    if (monthIdx >= 0) {
      return new Date(parseInt(monthYearMatch[2]), monthIdx, 1);
    }
  }

  // "YYYY-MM" ISO partial
  const isoMatch = lower.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, 1);
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
