import { Redis } from "@upstash/redis";

/**
 * Shared Upstash Redis client.
 * Reads UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN from env.
 *
 * Set these in:
 *   - .env.local for local dev
 *   - Vercel project settings → Environment Variables for production
 *
 * Get them from: https://console.upstash.com → your database → REST API
 */
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/** Key schema: user:{userId}:resume */
export const userResumeKey = (userId: string) => `user:${userId}:resume`;

/** Key schema: user:{userId}:profile */
export const userProfileKey = (userId: string) => `user:${userId}:profile`;

/** Key schema: submissions:{email}:{applicationId} — written by autoapply-worker */
export const submissionKey = (email: string, applicationId: string) =>
  `submissions:${email}:${applicationId}`;

/** Key schema: submissions:index:{email} — set of applicationIds the worker wrote */
export const submissionIndexKey = (email: string) => `submissions:index:${email}`;

/** Key schema: user:{email}:tenant_creds:{tenantHost} — written by the worker
 *  after createAccount succeeds. Reuse path also writes here. Plaintext for
 *  v1 — see createAccount.ts:118 for the trade-off note. */
export const tenantCredsKeyPrefix = (email: string) => `user:${email}:tenant_creds:`;

/** Key schema: console:{email}:{jobId} — Console job record (staging surface
 *  before the worker pipeline). One row per job the user has captured. */
export const consoleJobKey = (email: string, jobId: string) =>
  `console:${email}:${jobId}`;

/** Key schema: console:index:{email} — set of jobIds for fast list. */
export const consoleIndexKey = (email: string) => `console:index:${email}`;

/** Key schema: budget:{email}:{YYYY-MM} — running cents-spent counter for
 *  this user this calendar month. Reset implicitly by month rollover (the
 *  next month's key starts at 0). 90-day TTL keeps history queryable for
 *  reporting without growing unbounded. */
export const monthlyBudgetKey = (email: string, monthKey: string) =>
  `budget:${email}:${monthKey}`;
