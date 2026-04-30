/**
 * Analytics event schemas.
 *
 * Used by:
 *   - /api/events/ingest          (validates inbound events from chrome-extension/analytics.js)
 *   - /api/pipeline/stage         (validates kanban stage-change writes)
 *   - /api/dashboard/summary      (consumes events; not validated, just read)
 *
 * Source of truth for the wire format produced by chrome-extension/analytics.js
 * (`trackEvent(type, payload)`). When you add a new event type, add it here,
 * update the discriminated union below, then bump the extension version.
 *
 * Conventions:
 *   - userId is the user's email (matches session.user.email).
 *   - timestamp is ISO-8601; timestampMs mirrors Date.now() for fast range filters.
 *   - Event-specific fields are optional unless the dashboard reads them as required.
 */

import { z } from "zod";

// ── Common envelope ─────────────────────────────────────────────────────────
const BaseEvent = z.object({
  userId: z.string().email(),
  sessionId: z.string().min(1),
  extensionVersion: z.string().min(1),
  timestamp: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
});

// ── Per-type events ─────────────────────────────────────────────────────────
export const ApplicationSubmittedSchema = BaseEvent.extend({
  type: z.literal("application_submitted"),
  jobId: z.string().optional(),
  jobTitle: z.string().optional(),
  company: z.string().optional(),
  jobUrl: z.string().optional(),
  atsPlatform: z.string().optional(),
  matchScore: z.number().optional(),
  submittedAt: z.string().optional(),
});

export const ApplicationFailedSchema = BaseEvent.extend({
  type: z.literal("application_failed"),
  jobId: z.string().optional(),
  jobTitle: z.string().optional(),
  company: z.string().optional(),
  jobUrl: z.string().optional(),
  atsPlatform: z.string().optional(),
  failureReason: z.string().optional(),
});

export const FieldFilledSummarySchema = BaseEvent.extend({
  type: z.literal("field_filled_summary"),
  jobId: z.string().optional(),
  atsPlatform: z.string().optional(),
  fieldsAutoFilled: z.number().int().nonnegative().default(0),
  fieldsManual: z.number().int().nonnegative().default(0),
});

export const JobAnalyzedSchema = BaseEvent.extend({
  type: z.literal("job_analyzed"),
  jobId: z.string().optional(),
  jobTitle: z.string().optional(),
  company: z.string().optional(),
  jobUrl: z.string().optional(),
  matchScore: z.number().optional(),
  missedKeywords: z.array(z.string()).optional(),
});

export const ResponseReceivedSchema = BaseEvent.extend({
  type: z.literal("response_received"),
  jobId: z.string().optional(),
  jobTitle: z.string().optional(),
  company: z.string().optional(),
  responseType: z.enum(["interview_invite", "rejection", "offer", "other"]),
});

export const PipelineStageChangedSchema = BaseEvent.extend({
  type: z.literal("pipeline_stage_changed"),
  jobId: z.string().min(1),
  fromStage: z.string().min(1),
  toStage: z.string().min(1),
  jobTitle: z.string().optional(),
  company: z.string().optional(),
});

// ── Discriminated union of every accepted event ─────────────────────────────
export const EventSchema = z.discriminatedUnion("type", [
  ApplicationSubmittedSchema,
  ApplicationFailedSchema,
  FieldFilledSummarySchema,
  JobAnalyzedSchema,
  ResponseReceivedSchema,
  PipelineStageChangedSchema,
]);

export type AnalyticsEvent = z.infer<typeof EventSchema>;

// ── Dedup key normalisation ─────────────────────────────────────────────────
// MUST match chrome-extension/analytics.js `normalizeDedupKey` byte-for-byte
// so client-side dedup checks and server-side rollups agree on the key.
export function normalizeDedupKey(company: string, title: string): string {
  const normalize = (s: string) =>
    (s || "")
      .toLowerCase()
      .replace(/[,\.]+/g, "")
      .replace(/\b(inc|llc|ltd|corp|co|company|technologies|solutions|group|global)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return `${normalize(company)}|${normalize(title)}`;
}
