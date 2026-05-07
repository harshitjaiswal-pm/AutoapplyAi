/**
 * GET /api/credentials
 *
 * Lists every Workday tenant the worker has created an account on for the
 * logged-in user, with the email + password we set. Reads
 * user:{email}:tenant_creds:{tenantHost} keys from Upstash (written by the
 * worker's createAccount step).
 *
 * The worker stores the plaintext password by design — these are throwaway
 * job-application accounts, and the user explicitly requested a way to
 * look them up so they can manually sign in to a tenant's portal later.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis, tenantCredsKeyPrefix } from "@/lib/redis";

export interface TenantCredsRow {
  tenantHost: string;
  email: string;
  password: string;
  applicationId?: string;
  jobUrl?: string;
  createdAt?: string;
  successPath?: string;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;

  try {
    // Upstash supports SCAN. Page through all tenant_creds keys for this user.
    const prefix = tenantCredsKeyPrefix(email);
    const matched: string[] = [];
    let cursor = 0;
    do {
      const res = await redis.scan(cursor, { match: `${prefix}*`, count: 200 });
      // Upstash redis returns [nextCursor, keys] but the @upstash/redis JS
      // client returns it as { cursor, keys } shape with a single tuple
      // [number, string[]] — handle both robustly.
      const next = Array.isArray(res) ? res[0] : (res as unknown as { cursor: number }).cursor;
      const keys = (Array.isArray(res) ? res[1] : (res as unknown as { keys: string[] }).keys) ?? [];
      matched.push(...keys);
      cursor = typeof next === "string" ? parseInt(next, 10) : Number(next ?? 0);
    } while (cursor !== 0);

    if (matched.length === 0) {
      return NextResponse.json({ credentials: [] });
    }

    const rows = (await redis.mget(...matched)) as (TenantCredsRow | null)[];
    const credentials = rows
      .filter((r): r is TenantCredsRow => r !== null && !!r.tenantHost)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    return NextResponse.json({ credentials });
  } catch (err) {
    console.error("Failed to list tenant credentials:", err);
    return NextResponse.json({ error: "Failed to load credentials" }, { status: 500 });
  }
}
