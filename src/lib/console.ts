import { redis, consoleJobKey, consoleIndexKey } from "./redis";

/**
 * One Console job — staging row between job discovery and the worker
 * submission pipeline. Multiple sources (extension scrape, paste-URL,
 * search-and-add) merge into ONE record per canonical URL.
 *
 * State transitions:
 *   captured → queued (user clicks Apply)
 *   queued  → running (worker picks up, lane=primary)
 *   running → submitted | failed
 *   failed  → queued (user re-queues, lane=retry)
 *   captured → archived (user dismisses without applying)
 */
export type ConsoleJobState =
  | "captured"
  | "queued"
  | "running"
  | "submitted"
  | "failed"
  | "archived";

export type ConsoleJobSource = "extension" | "paste" | "csv" | "search";

export type QueueLane = "primary" | "retry";

export type AtsType = "workday" | "greenhouse" | "lever" | "ashby" | "other";

export interface ConsoleJob {
  id: string;
  state: ConsoleJobState;

  /** Sources merged into one record. Adding a duplicate URL pushes the
   *  source into this array (deduped) instead of creating a new row. */
  sources: ConsoleJobSource[];
  capturedAt: string;
  lastSeenAt: string;

  /** Canonical URL (lowercased host, no trailing slash, no tracking params). */
  url: string;
  /** Every URL variant we've seen, for dedup audit. */
  rawUrls: string[];

  title: string;
  company: string;
  location: string;
  ats: AtsType;

  /** 0–100, computed by /api/score-match against the user's parsedResume. */
  matchScore?: number;
  /** User-editable freeform notes. */
  notes?: string;

  // Queue placement (set when state moves to queued)
  queueLane?: QueueLane;
  queuedAt?: string;
  retryCount: number;

  // Linked worker run (set after dispatcher picks the job up)
  applicationId?: string;
  worker?: {
    startedAt?: string;
    finishedAt?: string;
    status?: string;
  };

  /** Set when a capture's URL is a LinkedIn /jobs/view/ URL rather than
   *  a real ATS URL — the worker can't drive LinkedIn, so these rows
   *  must be applied to manually. /api/console/enqueue refuses these
   *  with a 422 + actionable error. */
  manualOnly?: boolean;
}

/**
 * Strip a URL down to a stable comparison key. Handles:
 *  - trailing slash
 *  - lowercase host (URLs are case-sensitive in path but Workday tenants
 *    often vary by host casing; lowercase is safe for the host)
 *  - drop tracking params (utm_*, gh_src, ref, source, fbclid, gclid)
 *  - drop fragment
 *
 * Path stays case-sensitive — Workday job slugs encode the title. Two
 * URLs with different paths are different jobs even if the slug is just
 * a typo. (We surface near-matches as `possible_duplicate` in the UI
 * rather than auto-merging.)
 */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.host = u.host.toLowerCase();
    u.hash = "";
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gh_src", "ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid"];
    for (const k of drop) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    // Not a parseable URL — return as-is, lowercased + trimmed.
    return raw.trim().toLowerCase();
  }
}

/** Detect ATS from URL host. Returns "other" for unknown tenants. */
export function detectAts(url: string): AtsType {
  const host = (() => {
    try { return new URL(url).host.toLowerCase(); } catch { return ""; }
  })();
  if (host.includes("myworkdayjobs.com")) return "workday";
  if (host.includes("greenhouse.io")) return "greenhouse";
  if (host.includes("lever.co")) return "lever";
  if (host.includes("ashbyhq.com")) return "ashby";
  return "other";
}

export async function listConsoleJobs(email: string): Promise<ConsoleJob[]> {
  const ids = (await redis.smembers(consoleIndexKey(email))) as string[];
  if (!ids?.length) return [];
  const blobs = (await redis.mget(...ids.map((id) => consoleJobKey(email, id)))) as (ConsoleJob | null)[];
  return blobs
    .filter((b): b is ConsoleJob => b !== null)
    .sort((a, b) => (b.capturedAt || "").localeCompare(a.capturedAt || ""));
}

export async function getConsoleJob(email: string, jobId: string): Promise<ConsoleJob | null> {
  return (await redis.get<ConsoleJob>(consoleJobKey(email, jobId))) ?? null;
}

export async function saveConsoleJob(email: string, job: ConsoleJob): Promise<void> {
  await redis.set(consoleJobKey(email, job.id), job);
  await redis.sadd(consoleIndexKey(email), job.id);
}

/**
 * Find an existing job by canonical URL. Used by the create handler to
 * merge duplicate captures from different sources rather than spawn a
 * new row each time.
 */
export async function findByUrl(email: string, canonicalUrl: string): Promise<ConsoleJob | null> {
  const jobs = await listConsoleJobs(email);
  return jobs.find((j) => j.url === canonicalUrl) ?? null;
}
