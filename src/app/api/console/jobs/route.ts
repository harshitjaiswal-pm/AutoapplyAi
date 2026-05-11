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
import { validateAndScrapeUrl } from "@/lib/jdValidator";
import { redis } from "@/lib/redis";

/** Hard cap on Console captures per user per UTC day. Protects against
 *  a runaway scraper or an over-eager LinkedIn pull turning into a
 *  LinkedIn ToS issue. Server-side enforced — the extension cap is
 *  advisory only. */
const DAILY_CAPTURE_CAP = 100;
const DAILY_CAPTURE_TTL_SECONDS = 60 * 60 * 26; // 26h — slack for clock skew

function dailyCounterKey(email: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  return `console:daily_capture:${email}:${today}`;
}

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
  /** Forwarded by the LinkedIn-pull extension when the capture URL is a
   *  LinkedIn /jobs/view/ URL we couldn't resolve to a real ATS URL. */
  manualOnly?: boolean;
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
  // Skip the validator round-trip — we already have this URL, no
  // point re-checking it on every dedup.
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

  // Daily cap check — only enforce on NEW captures (merges don't count;
  // a re-capture of an already-saved URL shouldn't burn quota).
  const dailyKey = dailyCounterKey(email);
  const currentCount = (await redis.get<number>(dailyKey)) ?? 0;
  if (currentCount >= DAILY_CAPTURE_CAP) {
    return NextResponse.json(
      {
        error: `Daily capture cap reached (${DAILY_CAPTURE_CAP} per UTC day). Try again tomorrow or archive some captured jobs to free room.`,
        capCount: DAILY_CAPTURE_CAP,
        currentCount,
      },
      { status: 429 }
    );
  }

  // Capture-time validation. Server-side fetch the URL to detect dead
  // listings before they pollute the queue (24% of historical failures
  // were `job_posting_dead`). Bonus: scrape title + company from the
  // page when alive, so paste-flow rows don't show "—" placeholders.
  // Skip when the caller already supplied both title AND company (the
  // Chrome extension's LinkedIn capture sends real values), avoiding
  // an unnecessary fetch.
  const callerHasMetadata = !!(body.title?.trim() && body.company?.trim());
  let scrapedTitle: string | undefined;
  let scrapedCompany: string | undefined;
  if (!callerHasMetadata) {
    // Validate against the ORIGINAL URL (with query params) rather than
    // the canonical one — some Workday tenants render different content
    // based on `?source=...` presence, and stripping it before fetching
    // can cause a real listing to look dead. Canonical form is still the
    // dedup key; original is just the liveness probe.
    const validation = await validateAndScrapeUrl(body.url);
    if (!validation.alive) {
      return NextResponse.json(
        { error: validation.reason },
        { status: 422 }
      );
    }
    scrapedTitle = validation.title;
    scrapedCompany = validation.company;
  }

  const job: ConsoleJob = {
    id: randomUUID(),
    state: "captured",
    sources: [source],
    capturedAt: now,
    lastSeenAt: now,
    url: canonical,
    rawUrls: [body.url],
    title: body.title?.trim() || scrapedTitle || "—",
    company: body.company?.trim() || scrapedCompany || "—",
    location: body.location?.trim() || "",
    ats: detectAts(canonical),
    matchScore: body.matchScore,
    notes: body.notes,
    retryCount: 0,
    // Auto-flag unsupported-ATS captures as manualOnly so they don't auto-
    // queue and immediately fail with "Unsupported ATS family" exit code.
    // The worker drives Workday, Greenhouse, Ashby, Lever. Anything else
    // (Eightfold, iCIMS, SmartRecruiters, Taleo, company-hosted SPAs like
    // Brex/Fortis Games) is on the user to apply manually. Setting
    // manualOnly=true at capture time means the row renders as "Open in
    // LinkedIn" instead of "Re-queue" — clear expectation, no wasted
    // 1-second worker exits. Caught 2026-05-11: LinkedIn pull captured
    // Eaton (eightfold.ai) + Fortis Games (company SPA), both auto-queued
    // and failed in <1s.
    manualOnly: !!body.manualOnly || detectAts(canonical) === "other",
  };
  await saveConsoleJob(email, job);

  // Increment the daily counter AFTER a successful save so a save
  // failure doesn't burn quota. INCR is atomic; first call sets to 1
  // and we expire immediately after to bound the key's lifetime.
  const next = await redis.incr(dailyKey);
  if (next === 1) {
    await redis.expire(dailyKey, DAILY_CAPTURE_TTL_SECONDS);
  }

  return NextResponse.json(
    { job, merged: false, dailyRemaining: Math.max(0, DAILY_CAPTURE_CAP - next) },
    { status: 201 }
  );
}
