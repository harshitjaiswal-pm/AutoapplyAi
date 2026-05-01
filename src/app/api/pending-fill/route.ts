import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";

/**
 * GET /api/pending-fill?atsHost=career17.sapsf.com&reqId=53566
 *
 * Reads the pending form-fill answers that the worker computed in its
 * headless Playwright session and persisted to Upstash Redis. The Chrome
 * extension content script calls this when the user lands on a known ATS
 * application form, then applies the saved answers to the live form in the
 * user's actual browser session.
 *
 * Why this exists: the worker fills the form in an isolated Playwright
 * browser server-side, but those fills don't persist to the user's session
 * (SAP has no "Save Draft" button on this form). This endpoint is the
 * worker→extension handoff bridge.
 *
 * Auth: NextAuth session (web app) OR shared-secret + X-User-Id header
 * (extension running in MV3 service worker, no session cookie). The
 * shared-secret path is gated on WORKER_SHARED_SECRET being set; otherwise
 * extension callers will 401 and fall back to the session path.
 *
 * Key format (mirrors worker/upstashRedis.ts savePendingFill):
 *   user:{userId}:pending_fill:{atsHost}:{reqId}
 *
 * CORS open so the extension content script (running on career17.sapsf.com)
 * can fetch from autoapply-ai-delta.vercel.app.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Worker-Token, X-User-Id",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function authorize(req: NextRequest): Promise<{ userId: string } | null> {
  // Extension / worker path: shared secret + asserted userId
  const workerToken = req.headers.get("x-worker-token");
  if (workerToken) {
    const expected = process.env.WORKER_SHARED_SECRET;
    if (expected && workerToken === expected) {
      const userId = req.headers.get("x-user-id");
      if (userId && /.+@.+\..+/.test(userId)) return { userId };
    }
    return null;
  }
  // Web app path: NextAuth session
  const session = await getServerSession(authOptions);
  if (session?.user?.email) return { userId: session.user.email };
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await authorize(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const atsHost = req.nextUrl.searchParams.get("atsHost");
  const reqId = req.nextUrl.searchParams.get("reqId");
  if (!atsHost || !reqId) {
    return NextResponse.json(
      { error: "atsHost and reqId query params required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const key = `user:${auth.userId}:pending_fill:${atsHost}:${reqId}`;
  let raw: unknown;
  try {
    raw = await redis.get(key);
  } catch (err) {
    console.error("[pending-fill] redis error:", (err as Error).message);
    return NextResponse.json(
      { error: "Storage unavailable" },
      { status: 503, headers: CORS_HEADERS }
    );
  }

  if (!raw) {
    return NextResponse.json(
      { found: false, message: "No pending fill for this user/ats/req. Trigger a worker run first." },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  let fill: unknown;
  if (typeof raw === "string") {
    try { fill = JSON.parse(raw); } catch { fill = raw; }
  } else {
    fill = raw;
  }

  return NextResponse.json({ found: true, fill }, { headers: CORS_HEADERS });
}
