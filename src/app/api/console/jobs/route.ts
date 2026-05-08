/**
 * GET  /api/console/jobs            — list this user's Console jobs (state filter optional)
 * POST /api/console/jobs            — capture a new job; merges with existing row on URL match
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { randomUUID } from "node:crypto";
import {
  type ConsoleJob,
  type ConsoleJobSource,
  canonicalizeUrl,
  detectAts,
  findByUrl,
  listConsoleJobs,
  saveConsoleJob,
} from "@/lib/console";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const stateFilter = req.nextUrl.searchParams.get("state");
  let jobs = await listConsoleJobs(session.user.email);
  if (stateFilter) jobs = jobs.filter((j) => j.state === stateFilter);
  return NextResponse.json({ jobs });
}

interface CreateBody {
  url: string;
  title?: string;
  company?: string;
  location?: string;
  source?: ConsoleJobSource;
  matchScore?: number;
  notes?: string;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const canonical = canonicalizeUrl(body.url);
  const now = new Date().toISOString();
  const source: ConsoleJobSource = body.source ?? "paste";

  // Dedup-merge if a row with this canonical URL already exists.
  const existing = await findByUrl(email, canonical);
  if (existing) {
    const merged: ConsoleJob = {
      ...existing,
      lastSeenAt: now,
      sources: Array.from(new Set([...existing.sources, source])),
      rawUrls: Array.from(new Set([...existing.rawUrls, body.url])),
      // Refresh fields ONLY if the new capture has values and the existing row
      // is missing them — never clobber what the user has already curated.
      title: existing.title || body.title || existing.title,
      company: existing.company || body.company || existing.company,
      location: existing.location || body.location || existing.location,
      matchScore: existing.matchScore ?? body.matchScore,
    };
    await saveConsoleJob(email, merged);
    return NextResponse.json({ job: merged, merged: true });
  }

  const job: ConsoleJob = {
    id: randomUUID(),
    state: "captured",
    sources: [source],
    capturedAt: now,
    lastSeenAt: now,
    url: canonical,
    rawUrls: [body.url],
    title: body.title?.trim() || "—",
    company: body.company?.trim() || "—",
    location: body.location?.trim() || "",
    ats: detectAts(canonical),
    matchScore: body.matchScore,
    notes: body.notes,
    retryCount: 0,
  };
  await saveConsoleJob(email, job);
  return NextResponse.json({ job, merged: false }, { status: 201 });
}
