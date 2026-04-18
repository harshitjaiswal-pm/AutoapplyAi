/**
 * GET /api/dashboard/summary?range=7d|30d|all
 *
 * Returns all widget data in a single pre-aggregated response.
 * No client-side heavy lifting — all math happens here.
 *
 * Drop into src/app/api/dashboard/summary/route.ts
 *
 * Response shape (all widgets A–I):
 * {
 *   funnel:          FunnelData,          // Widget A
 *   channelBreakdown: ChannelData[],      // Widget B
 *   atsMatrix:       AtsMatrixRow[],      // Widget C
 *   responseCohorts: CohortRow[],         // Widget D
 *   matchCalibration: MatchPoint[],       // Widget E
 *   keywordGaps:     KeywordGap[],        // Widget F
 *   effortOutcome:   EffortOutcomeData,   // Widget G
 *   failureLog:      FailureEntry[],      // Widget H
 *   pipeline:        PipelineEntry[],     // Widget I
 *   duplicatesBlocked: number,
 *   dataRange:       string,
 *   generatedAt:     string,
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, all: Infinity };

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId  = session.user.email;
  const range   = req.nextUrl.searchParams.get("range") ?? "30d";
  const rangeDays = RANGE_DAYS[range] ?? 30;
  const cutoffMs  = rangeDays === Infinity ? 0 : Date.now() - rangeDays * 86_400_000;
  const prefix    = `user:${userId}`;

  // ── Fetch all needed data from Redis ────────────────────────────────────────
  // FIX: Wrap Promise.all in try-catch so any Redis transient failure returns
  // a graceful error response instead of crashing the entire dashboard.
  // FIX: Bound event fetch to 2k (not 10k) to limit per-request memory.
  const EVENT_FETCH_LIMIT = 2000;
  let rawEvents: string[] = [];
  let funnelRaw: Record<string, string> | null = null;
  let submittedPlatforms: string[] = [];
  let keywordMissesRaw: Record<string, string> | null = null;

  try {
    [rawEvents, funnelRaw, submittedPlatforms, keywordMissesRaw] =
      await Promise.all([
        redis.lrange(`${prefix}:events`, 0, EVENT_FETCH_LIMIT - 1),
        redis.hgetall(`${prefix}:funnel_counters`),
        redis.smembers(`${prefix}:submitted_platforms`),
        redis.hgetall(`${prefix}:keyword_misses`),
      ]) as [string[], Record<string, string>, string[], Record<string, string>];
  } catch (redisErr) {
    console.error("[dashboard/summary] Redis fetch failed:", (redisErr as Error).message);
    return NextResponse.json({ error: "Data temporarily unavailable" }, { status: 503 });
  }

  // Parse events JSON, filter by time range
  const events: Record<string, unknown>[] = (rawEvents as string[])
    .map((e) => { try { return JSON.parse(e); } catch { return null; } })
    .filter((e): e is Record<string, unknown> => !!e && typeof e.timestampMs === "number")
    .filter((e) => (e.timestampMs as number) >= cutoffMs);

  // ── Fetch per-platform ATS stats — batched in a single pipeline ─────────────
  // FIX: Use Redis pipeline instead of Promise.all with individual calls (N+1).
  const platforms = Array.from(new Set([
    ...(submittedPlatforms as string[]),
    "greenhouse", "lever", "workday", "linkedin_easy_apply", "generic",
  ]));

  let atsStatsList: Array<{ platform: string } & Record<string, string>> = [];
  try {
    const atsPipeline = redis.pipeline();
    for (const p of platforms) atsPipeline.hgetall(`${prefix}:ats_stats:${p}`);
    const atsResults = await atsPipeline.exec();
    atsStatsList = platforms.map((p, i) => ({
      platform: p,
      ...((atsResults?.[i] as Record<string, string>) ?? {}),
    }));
  } catch (atsErr) {
    console.warn("[dashboard/summary] ATS stats fetch failed:", (atsErr as Error).message);
    // Non-fatal: continue without ATS matrix data
  }

  // ── Widget A: Funnel ────────────────────────────────────────────────────────
  const countByType = (type: string) =>
    events.filter((e) => e.type === type).length;

  const discovered  = countByType("job_discovered");
  const analyzed    = countByType("job_analyzed");
  const started     = countByType("application_started");
  const submitted   = countByType("application_submitted");
  const responded   = events.filter((e) =>
    e.type === "response_received" &&
    !["ghost_14d", "ghost_30d"].includes(e.responseType as string)
  ).length;
  const interviews  = events.filter((e) =>
    e.type === "response_received" && e.responseType === "interview_invite"
  ).length;
  const offers      = events.filter((e) =>
    e.type === "response_received" && e.responseType === "offer"
  ).length;

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

  const funnel = {
    stages: [
      { name: "Discovered",  count: discovered, conversionPct: null },
      { name: "Analyzed",    count: analyzed,   conversionPct: pct(analyzed, discovered) },
      { name: "Started",     count: started,    conversionPct: pct(started, analyzed) },
      { name: "Submitted",   count: submitted,  conversionPct: pct(submitted, started) },
      { name: "Response",    count: responded,  conversionPct: pct(responded, submitted) },
      { name: "Interview",   count: interviews, conversionPct: pct(interviews, responded) },
      { name: "Offer",       count: offers,     conversionPct: pct(offers, interviews) },
    ],
    note: analyzed === 0 && submitted > 0
      ? "Funnel shows Greenhouse + LinkedIn Easy Apply only until full instrumentation is deployed."
      : undefined,
  };

  // ── Widget B: Channel breakdown ─────────────────────────────────────────────
  const easyApplySubmits = events.filter(
    (e) => e.type === "application_submitted" && e.atsPlatform === "linkedin_easy_apply"
  );
  const externalSubmits  = events.filter(
    (e) => e.type === "application_submitted" && e.atsPlatform !== "linkedin_easy_apply"
  );
  const easyApplyResponded = events.filter(
    (e) => e.type === "response_received" && easyApplySubmits.some((s) => s.jobId === e.jobId)
  );
  const externalResponded  = events.filter(
    (e) => e.type === "response_received" && externalSubmits.some((s) => s.jobId === e.jobId)
  );

  const median = (arr: number[]) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const eaDurations = easyApplySubmits.map((e) => e.totalDurationMs as number).filter(Boolean);
  const extDurations = externalSubmits.map((e) => e.totalDurationMs as number).filter(Boolean);

  const channelBreakdown = [
    {
      channel:         "LinkedIn Easy Apply",
      volume:          easyApplySubmits.length,
      submitRate:      pct(easyApplySubmits.length, countByType("application_started")),
      medianDurationMs: median(eaDurations),
      responseRate:    pct(easyApplyResponded.length, easyApplySubmits.length),
    },
    {
      channel:         "External ATS",
      volume:          externalSubmits.length,
      submitRate:      null, // calculated as share of starts going to external
      medianDurationMs: median(extDurations),
      responseRate:    pct(externalResponded.length, externalSubmits.length),
    },
  ];

  // ── Widget C: ATS reliability matrix ────────────────────────────────────────
  const atsMatrix = atsStatsList
    .filter((row) => parseInt(row.submitted || "0") > 0 || row.platform === "greenhouse" || row.platform === "linkedin_easy_apply")
    .map((row) => {
      const sub    = parseInt(row.submitted  || "0");
      const fieldsA = parseInt(row.fields_auto  || "0");
      const fieldsM = parseInt(row.fields_manual || "0");
      const failed  = parseInt(row.failed     || "0");
      const started = events.filter(
        (e) => e.type === "application_started" && e.atsPlatform === row.platform
      ).length;
      return {
        platform:        row.platform,
        started,
        submitted:       sub,
        submitRate:      pct(sub, started),
        autoFillRate:    fieldsA + fieldsM > 0 ? pct(fieldsA, fieldsA + fieldsM) : null,
        medianManualFields: fieldsM > 0 ? Math.round(fieldsM / Math.max(sub, 1)) : 0,
        failedCount:     failed,
      };
    });

  // ── Widget D: Response-rate cohorts ─────────────────────────────────────────
  const submittedEvents = events.filter((e) => e.type === "application_submitted");
  const weekKey = (ts: number) => {
    const d = new Date(ts);
    const startOfWeek = new Date(d);
    startOfWeek.setDate(d.getDate() - d.getDay());
    return startOfWeek.toISOString().slice(0, 10);
  };

  // FIX: Build jobId → submittedEvent lookup map to avoid O(n²) find() in loops.
  const submittedByJobId = new Map(submittedEvents.map((e) => [e.jobId as string, e]));
  // Build jobId → response event map (first response per job)
  const responseByJobId = new Map<string, Record<string, unknown>>();
  for (const e of events.filter((e) => e.type === "response_received")) {
    const jid = e.jobId as string;
    if (jid && !responseByJobId.has(jid)) responseByJobId.set(jid, e);
  }

  const cohortMap: Record<string, { applied: number; responded: number; daysToResponse: number[] }> = {};
  for (const e of submittedEvents) {
    const wk = weekKey(e.timestampMs as number);
    if (!cohortMap[wk]) cohortMap[wk] = { applied: 0, responded: 0, daysToResponse: [] };
    cohortMap[wk].applied++;
  }
  for (const [jobId, e] of responseByJobId) {
    const submitEvt = submittedByJobId.get(jobId);
    if (!submitEvt) continue;
    const wk = weekKey(submitEvt.timestampMs as number);
    if (!cohortMap[wk]) continue;
    cohortMap[wk].responded++;
    if (typeof e.daysSinceApply === "number") cohortMap[wk].daysToResponse.push(e.daysSinceApply as number);
  }

  const responseCohorts = Object.entries(cohortMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, c]) => ({
      week,
      applied:          c.applied,
      responded:        c.responded,
      responsePct:      pct(c.responded, c.applied),
      medianDaysToResponse: median(c.daysToResponse),
      ghostedPct14d:    null as number | null, // requires 14d follow-up events — not implemented yet
    }));

  // ── Widget E: Match-score calibration ───────────────────────────────────────
  // FIX: Use responseByJobId map (O(1) lookup) instead of find() inside map (O(n²)).
  const matchCalibration = submittedEvents
    .filter((e) => typeof e.matchScore === "number" && e.matchScore > 0)
    .map((e) => {
      const response = responseByJobId.get(e.jobId as string);
      return {
        jobId:      e.jobId,
        jobTitle:   e.jobTitle,
        company:    e.company,
        matchScore: e.matchScore as number,
        outcome:    response ? (response.responseType as string) : "submitted",
      };
    });

  // ── Widget F: Keyword gap report ────────────────────────────────────────────
  const keywordGaps = Object.entries(keywordMissesRaw || {})
    .map(([keyword, count]) => ({ keyword, count: parseInt(count as string) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // ── Widget G: Effort per outcome ────────────────────────────────────────────
  const totalMs       = submittedEvents.reduce((sum, e) => sum + ((e.totalDurationMs as number) || 0), 0);
  const totalMinutes  = Math.round(totalMs / 60_000);
  const effortOutcome = {
    totalMinutesInvested: totalMinutes,
    totalSubmitted:       submitted,
    totalResponded:       responded,
    totalInterviews:      interviews,
    totalOffers:          offers,
    minutesPerSubmit:     submitted > 0 ? Math.round(totalMinutes / submitted) : null,
    minutesPerResponse:   responded > 0 ? Math.round(totalMinutes / responded) : null,
    minutesPerInterview:  interviews > 0 ? Math.round(totalMinutes / interviews) : null,
    minutesPerOffer:      offers > 0 ? Math.round(totalMinutes / offers) : null,
    note: totalMinutes === 0 ? "Duration data will populate after submitting applications with v3.1+ extension." : undefined,
  };

  // ── Widget H: Failure log ────────────────────────────────────────────────────
  const failureLog = events
    .filter((e) => e.type === "application_failed")
    .slice(0, 20)
    .map((e) => ({
      jobId:       e.jobId,
      jobTitle:    e.jobTitle,
      company:     e.company,
      atsPlatform: e.atsPlatform,
      stage:       e.stage,
      errorCode:   e.errorCode,
      errorMessage: e.errorMessage,
      timestamp:   e.timestamp,
      jobUrl:      e.jobUrl,
    }));

  // ── Widget I: Pipeline (kanban) ──────────────────────────────────────────────
  // Reconstruct kanban state from pipeline_stage_changed events
  // and application_submitted as the starting state.
  const stageMap: Record<string, string> = {};
  const jobMeta:  Record<string, Record<string, unknown>> = {};

  for (const e of submittedEvents) {
    stageMap[e.jobId as string] = "applied";
    jobMeta[e.jobId as string]  = { jobTitle: e.jobTitle, company: e.company, jobUrl: e.jobUrl, submittedAt: e.submittedAt || e.timestamp };
  }
  for (const e of events.filter((e) => e.type === "pipeline_stage_changed")) {
    stageMap[e.jobId as string] = e.toStage as string;
  }

  const pipeline_kanban = Object.entries(stageMap).map(([jobId, stage]) => ({
    jobId,
    stage,
    ...(jobMeta[jobId] || {}),
  }));

  // ── Duplicates blocked ───────────────────────────────────────────────────────
  const duplicatesBlocked = countByType("application_duplicate_blocked");

  // ── Compose response ─────────────────────────────────────────────────────────
  return NextResponse.json({
    funnel,
    channelBreakdown,
    atsMatrix,
    responseCohorts,
    matchCalibration,
    keywordGaps,
    effortOutcome,
    failureLog,
    pipeline: pipeline_kanban,
    duplicatesBlocked,
    dataRange:   range,
    generatedAt: new Date().toISOString(),
  });
}
