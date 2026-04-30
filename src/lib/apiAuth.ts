import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/**
 * Authorize an inbound /api/* request.
 *
 * Two accepted credential modes:
 *
 *   A. Browser session (web app, /tailor page, /dashboard)
 *      The user is signed in to NextAuth. Cookies carry the session.
 *      → userId = session.user.email
 *
 *   B. Shared-secret + asserted userId (worker on Railway, Chrome extension)
 *      Caller has no browser session. Sends:
 *        X-Worker-Token: process.env.WORKER_SHARED_SECRET
 *        X-User-Id:      <email>
 *      The token proves "this is one of our trusted callers"; the userId
 *      header tells us which user the call is on behalf of. The token is
 *      shared across the worker and all extension installs — protection
 *      against random internet strangers, not against a compromised extension.
 *
 * Returns the resolved userId or null if neither mode authenticates.
 */
export async function authorize(req: NextRequest): Promise<{ userId: string } | null> {
  // Mode B: shared-secret first (cheaper — no DB hit)
  const workerToken = req.headers.get("x-worker-token");
  if (workerToken) {
    const expected = process.env.WORKER_SHARED_SECRET;
    if (expected && workerToken === expected) {
      const userId = req.headers.get("x-user-id");
      if (userId && /.+@.+\..+/.test(userId)) {
        return { userId };
      }
    }
    // Token present but invalid → reject. Don't fall through to session check;
    // a bogus token is a strong signal of misuse.
    return null;
  }

  // Mode A: NextAuth session
  const session = await getServerSession(authOptions);
  if (session?.user?.email) {
    return { userId: session.user.email };
  }

  return null;
}
