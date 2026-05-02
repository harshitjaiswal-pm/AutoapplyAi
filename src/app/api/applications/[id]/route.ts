/**
 * GET /api/applications/[id]
 *   Returns the full audit record for one application.
 *
 * POST /api/applications/[id]/approve
 *   Marks the application status as "submitted_stubbed" and timestamps it.
 *   The real submit flow lives in the worker; this is the v1 stub.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";

interface AuditRecord {
  applicationId: string;
  userId: string;
  jobMeta: { jobUrl?: string; jobTitle?: string; company?: string };
  status: string;
  steps: unknown[];
  totalCostCents: number;
  totalDurationMs: number;
  createdAt: string;
  updatedAt: string;
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = ctx.params;
  const audit = await redis.get<AuditRecord>(`audit:${id}`);
  if (!audit) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (audit.userId !== session.user.email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ application: audit });
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = body.action as string | undefined;
  if (action !== "approve_stub") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const audit = await redis.get<AuditRecord>(`audit:${id}`);
  if (!audit) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (audit.userId !== session.user.email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  audit.status = "submitted_stubbed";
  audit.updatedAt = new Date().toISOString();
  await redis.set(`audit:${id}`, audit, { ex: 60 * 60 * 24 * 30 });

  return NextResponse.json({ ok: true, application: audit });
}
