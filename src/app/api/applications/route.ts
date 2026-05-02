/**
 * GET /api/applications
 *
 * Lists the current user's worker-driven applications.
 *
 * Strategy: read user:{email}:applications (a list of audit IDs the worker
 * appends to as it creates new applications), then fetch each audit:{id}
 * blob in parallel and return a thin summary per application.
 *
 * If user:{email}:applications doesn't exist yet (worker hasn't enqueued
 * anything), we return an empty list — UI shows the empty state.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";

interface AuditRecord {
  applicationId: string;
  queueJobId: string;
  userId: string;
  jobMeta: { jobUrl?: string; jobTitle?: string; company?: string };
  status: "pending" | "in_progress" | "completed" | "failed" | "submitted_stubbed";
  steps: Array<{ stepName: string; status: string; durationMs?: number; costCents?: number }>;
  totalCostCents: number;
  totalDurationMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationSummary {
  applicationId: string;
  jobTitle: string;
  company: string;
  jobUrl?: string;
  status: AuditRecord["status"];
  stepCount: number;
  failedStepCount: number;
  totalCostCents: number;
  totalDurationMs: number;
  createdAt: string;
  updatedAt: string;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.email;

  // List of application IDs for this user, newest first.
  const ids = (await redis.lrange<string>(`user:${userId}:applications`, 0, 199)) ?? [];
  if (ids.length === 0) {
    return NextResponse.json({ applications: [] });
  }

  const records = await Promise.all(
    ids.map((id) => redis.get<AuditRecord>(`audit:${id}`))
  );

  const applications: ApplicationSummary[] = records
    .filter((r): r is AuditRecord => r !== null)
    .map((r) => ({
      applicationId: r.applicationId,
      jobTitle: r.jobMeta?.jobTitle ?? "(unknown title)",
      company: r.jobMeta?.company ?? "(unknown company)",
      jobUrl: r.jobMeta?.jobUrl,
      status: r.status,
      stepCount: r.steps.length,
      failedStepCount: r.steps.filter((s) => s.status === "failed").length,
      totalCostCents: r.totalCostCents,
      totalDurationMs: r.totalDurationMs,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return NextResponse.json({ applications });
}
