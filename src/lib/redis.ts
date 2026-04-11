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
