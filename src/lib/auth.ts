import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { redis } from "@/lib/redis";

/**
 * Gmail-readonly scope is requested alongside openid/email/profile so the
 * worker can poll the user's inbox for ATS verification emails and OTPs during
 * the account-creation flow. access_type=offline + prompt=consent ensures we
 * receive a refresh_token on first sign-in even if the user previously granted
 * consent to this OAuth client.
 */
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // ms epoch
  scope?: string;
  obtainedAt: number; // ms epoch
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: "/auth/signin",
  },
  callbacks: {
    /**
     * `account` is non-null on the first sign-in (or first re-consent). When it
     * is, persist the access_token + refresh_token to Redis so the worker can
     * call the Gmail API on the user's behalf. We never expose tokens to the
     * client; they live in `user:{email}:google_tokens`.
     *
     * DEBUG: also writes a `debug:jwt:{ts}` entry on every invocation while we
     * verify the OAuth consent flow end-to-end. This is removed once the
     * Phase A1 demo is green.
     */
    async jwt({ token, account, profile, trigger }) {
      // Diagnostic: see exactly what the callback receives. TTL 1hr.
      try {
        await redis.set(
          `debug:jwt:${Date.now()}`,
          {
            hasAccount: !!account,
            accountKeys: account ? Object.keys(account) : null,
            accountProvider: account?.provider ?? null,
            accountType: account?.type ?? null,
            profileEmail: profile?.email ?? null,
            profileKeys: profile ? Object.keys(profile) : null,
            tokenEmail: (token as { email?: string })?.email ?? null,
            trigger: trigger ?? null,
            hasAccessToken: !!(account as { access_token?: string })?.access_token,
            hasRefreshToken: !!(account as { refresh_token?: string })?.refresh_token,
            scope: (account as { scope?: string })?.scope ?? null,
          },
          { ex: 3600 }
        );
      } catch {
        /* never block sign-in for diagnostics */
      }

      if (account && profile?.email) {
        const tokens: GoogleTokens = {
          accessToken: account.access_token!,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at
            ? account.expires_at * 1000
            : Date.now() + 3600 * 1000,
          scope: account.scope,
          obtainedAt: Date.now(),
        };
        try {
          await redis.set(`user:${profile.email}:google_tokens`, tokens);
        } catch (err) {
          // Token-persist failure must not break sign-in. The worker just
          // won't have Gmail access until the next successful sign-in.
          console.error("Failed to persist Google tokens to Redis:", err);
        }
      }
      return token;
    },
    async session({ session, token }) {
      // Attach the user's stable Google ID to the session
      if (session.user && token.sub) {
        (session.user as typeof session.user & { id: string }).id = token.sub;
      }
      return session;
    },
  },
};
