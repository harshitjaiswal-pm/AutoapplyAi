/**
 * POST /api/pipeline/stage
 *
 * Records a pipeline stage change (kanban drag-to-move).
 * Body: { jobId, fromStage, toStage, jobTitle?, company? }
 *
 * Drop into src/app/api/pipeline/stage/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { PipelineStageChangedSchema } from "@/lib/eventSchemas";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.email;

  // FIX: Wrap req.json() in try-catch — malformed JSON would crash the handler.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const event = PipelineStageChangedSchema.safeParse({
    type:             "pipeline_stage_changed",
    userId,
    sessionId:        "web_app",
    extensionVersion: "web",
    timestamp:        new Date().toISOString(),
    timestampMs:      Date.now(),
    ...body,
  });

  if (!event.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const pipeline = redis.pipeline();
  pipeline.lpush(`user:${userId}:events`, JSON.stringify(event.data));
  pipeline.ltrim(`user:${userId}:events`, 0, 9999);

  // FIX: Do NOT auto-inject synthetic response_received events here.
  // Previously this caused double-counting when /api/events/ingest also received
  // a real response_received event for the same job.
  // Instead, only record the pipeline_stage_changed event.
  // The dashboard/summary route derives response counts purely from response_received events.
  // Users who move to Interview/Offer via kanban should also have the extension or
  // the web app fire a response_received event through /api/events/ingest directly.

  try {
    await pipeline.exec();
  } catch (err) {
    console.error("[pipeline/stage] Redis error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to save stage change" }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
