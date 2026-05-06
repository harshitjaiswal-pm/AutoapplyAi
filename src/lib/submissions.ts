import { redis, submissionKey, submissionIndexKey } from "./redis";

/**
 * Shape of one submission record. Written by autoapply-worker's
 * submissions.ts. Kept in sync there. The web app reads only — never
 * writes — so changes to the worker schema must keep this readable.
 */
export interface SubmissionScreenshot {
  step: string;
  pageHeader?: string;
  url: string;
  capturedAt: string;
}

export interface SubmissionStepLog {
  name: string;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  note?: string;
  error?: string;
}

export interface SubmissionRecord {
  applicationId: string;
  userId: string;
  jobUrl: string;
  jobTitle: string;
  company: string;
  tenant?: string;
  status: "in_progress" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  matchScore?: number;
  resumeFilename?: string;
  resumeUrl?: string;
  screenshots: SubmissionScreenshot[];
  steps: SubmissionStepLog[];
  errorMessage?: string;
  source: "smoke" | "queue";
}

/**
 * List submissions for one user, newest first.
 * Reads the index set then bulk-fetches each blob.
 */
export async function listSubmissions(email: string): Promise<SubmissionRecord[]> {
  const ids = (await redis.smembers(submissionIndexKey(email))) as string[];
  if (!ids || ids.length === 0) return [];

  const keys = ids.map((id) => submissionKey(email, id));
  // mget returns elements aligned with keys; missing keys come back as null.
  // Cast through unknown because @upstash/redis returns the auto-deserialized JSON.
  const blobs = (await redis.mget(...keys)) as (SubmissionRecord | null)[];

  const records = blobs.filter((b): b is SubmissionRecord => b !== null);
  records.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return records;
}

/**
 * Fetch one submission by id.
 */
export async function getSubmission(
  email: string,
  applicationId: string
): Promise<SubmissionRecord | null> {
  const data = await redis.get<SubmissionRecord>(submissionKey(email, applicationId));
  return data ?? null;
}
