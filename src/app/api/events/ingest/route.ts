/**
 * POST /api/events/ingest
 *
 * Receives a single analytics event from the Chrome extension.
 * Validates schema, writes to Redis event log + updates rollup hashes.
 *
 * Drop this into src/app/api/events/ingest/route.ts in the Next.js app.
 * Requires: src/lib/redis.ts (already exists), src/lib/eventSchemas.ts (new)
 *
 * Redis keys written:
 *   user:{userId}:events          — LIST  (append-only, capped at 10k entries)
 *   user:{userId}:applied_jobs    — HASH  (company|title → JSON dedup record)
 *   user:{userId}:funnel_counters — HASH  (event type → count)
 *   user:{userId}:ats_stats:{platform} — HASH (submitted, filled, failed counts)
 *   user:{userId}:keyword_misses  — HASH (keyword → count across last 50 jobs)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { EventSchema, normalizeDedupKey } from "@/lib/eventSchemas";
import { ZodError } from "zod";

const EVENTS_LIST_MAX = 10_000; // keep last 10k events per user

export async function POST(req: NextRequest) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const session = await getServerSession(authOptions);
    const userId  = session?.user?.email ?? null;

    // SECURITY FIX: Do NOT accept userId from request body — session-only.
    // The extension shares the browser session, so the cookie is present.
    // Removed body fallback to prevent unauthenticated spoofing.
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const effectiveUserId = userId;

    // ── Validate event schema ─────────────────────────────────────────────────
    const parseResult = EventSchema.safeParse({ ...body, userId: effectiveUserId });
    if (!parseResult.success) {
      const issues = (parseResult.error as ZodError).issues.map((i) => i.message).join("; ");
      return NextResponse.json({ error: "Invalid event", issues }, { status: 400 });
    }

    const event = parseResult.data;
    const prefix = `user:${effectiveUserId}`;

    // ── Build Redis pipeline ──────────────────────────────────────────────────
    const pipeline = redis.pipeline();

    // 1. Append to event log (trim to max)
    pipeline.lpush(`${prefix}:events`, JSON.stringify(event));
    pipeline.ltrim(`${prefix}:events`, 0, EVENTS_LIST_MAX - 1);

    // 2. Update funnel counters
    pipeline.hincrby(`${prefix}:funnel_counters`, event.type, 1);

    // 3. Event-specific rollups
    if (event.type === "application_submitted") {
      const platform = event.atsPlatform || "unknown";
      pipeline.hincrby(`${prefix}:ats_stats:${platform}`, "submitted", 1);
      pipeline.sadd(`${prefix}:submitted_platforms`, platform);

      // Dedup guard: mark as applied
      if (event.company && event.jobTitle) {
        const dedupKey = normalizeDedupKey(event.company, event.jobTitle);
        pipeline.hset(`${prefix}:applied_jobs`, {
          [dedupKey]: JSON.stringify({
            appliedAt: event.submittedAt || event.timestamp,
            jobUrl:    event.jobUrl ?? "",
            jobTitle:  event.jobTitle,
            company:   event.company,
          }),
        });
      }
    }

    if (event.type === "field_filled_summary") {
      const platform = event.atsPlatform || "unknown";
      pipeline.hincrby(`${prefix}:ats_stats:${platform}`, "fields_auto", event.fieldsAutoFilled);
      pipeline.hincrby(`${prefix}:ats_stats:${platform}`, "fields_manual", event.fieldsManual);
    }

    if (event.type === "application_failed") {
      const platform = event.atsPlatform || "unknown";
      pipeline.hincrby(`${prefix}:ats_stats:${platform}`, "failed", 1);
    }

    if (event.type === "job_analyzed") {
      // Accumulate missed keywords across all jobs for Widget F
      for (const kw of (event.missedKeywords ?? [])) {
        pipeline.hincrby(`${prefix}:keyword_misses`, kw.toLowerCase(), 1);
      }
    }

    if (event.type === "response_received") {
      pipeline.hincrby(`${prefix}:funnel_counters`, `response:${event.responseType}`, 1);
    }

    // ── Execute pipeline ──────────────────────────────────────────────────────
    await pipeline.exec();

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[events/ingest] error:", msg);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
