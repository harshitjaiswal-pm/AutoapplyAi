/**
 * GET /api/debug/gmail-status
 *
 * Verifies that the signed-in user has granted Gmail access and that the
 * stored OAuth tokens can successfully call the Gmail API.
 *
 * Returns:
 *   { ok: true,  tokensStored: true,  scope: "...", gmailProfile: {...}, msgCount: N }
 *   { ok: false, reason: "..." }
 *
 * If tokensStored is false → user needs to sign out and sign back in to
 * trigger the new consent prompt for the gmail.readonly scope.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redis } from "@/lib/redis";

interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  obtainedAt: number;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function refreshIfNeeded(email: string, stored: GoogleTokens): Promise<string> {
  if (stored.expiresAt - 60_000 > Date.now()) return stored.accessToken;
  if (!stored.refreshToken) {
    throw new Error("Access token expired and no refresh_token. Sign in again.");
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    refresh_token: stored.refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) throw new Error(`Token refresh failed: HTTP ${r.status}`);
  const data = (await r.json()) as { access_token: string; expires_in: number; scope?: string };
  const updated: GoogleTokens = {
    accessToken: data.access_token,
    refreshToken: stored.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? stored.scope,
    obtainedAt: Date.now(),
  };
  await redis.set(`user:${email}:google_tokens`, updated);
  return updated.accessToken;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, reason: "Not signed in" }, { status: 401 });
  }
  const email = session.user.email;

  const stored = await redis.get<GoogleTokens>(`user:${email}:google_tokens`);
  if (!stored) {
    return NextResponse.json({
      ok: false,
      tokensStored: false,
      reason:
        "No Google tokens stored. Sign out and sign back in to grant Gmail access.",
    });
  }

  const hasGmailScope = (stored.scope ?? "").includes("gmail.readonly");
  if (!hasGmailScope) {
    return NextResponse.json({
      ok: false,
      tokensStored: true,
      scope: stored.scope,
      reason:
        "Tokens are stored but missing gmail.readonly scope. Sign out and sign back in to re-consent.",
    });
  }

  let accessToken: string;
  try {
    accessToken = await refreshIfNeeded(email, stored);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      tokensStored: true,
      scope: stored.scope,
      reason: `Token refresh failed: ${(err as Error).message}`,
    });
  }

  // Hit Gmail's /profile endpoint as a cheap auth check
  const profRes = await fetch(`${GMAIL_API}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profRes.ok) {
    return NextResponse.json({
      ok: false,
      tokensStored: true,
      scope: stored.scope,
      reason: `Gmail API profile call failed: HTTP ${profRes.status}`,
    });
  }
  const profile = (await profRes.json()) as {
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
  };

  return NextResponse.json({
    ok: true,
    tokensStored: true,
    scope: stored.scope,
    refreshTokenPresent: !!stored.refreshToken,
    obtainedAt: new Date(stored.obtainedAt).toISOString(),
    gmailProfile: {
      emailAddress: profile.emailAddress,
      messagesTotal: profile.messagesTotal,
      threadsTotal: profile.threadsTotal,
    },
  });
}
