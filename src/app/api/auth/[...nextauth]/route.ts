import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

// IMPORTANT: this handler MUST use the same authOptions that getServerSession()
// reads, otherwise the sign-in flow's jwt() and session() callbacks diverge
// from what API routes see. Previously this file had its own inline config
// (no Gmail scope, no jwt callback) which silently dropped all OAuth changes
// made in src/lib/auth.ts. Don't reintroduce.
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
