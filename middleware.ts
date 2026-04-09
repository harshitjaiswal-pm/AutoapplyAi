import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequestWithAuth } from "next-auth/middleware";

export default withAuth(
  function middleware(req: NextRequestWithAuth) {
    const token = req.nextauth.token;

    // If user is authenticated
    if (token) {
      const cookies = req.cookies;
      const onboardingComplete = cookies.get("aa_onboarding_complete");

      // If onboarding not complete, redirect to /onboarding
      // (except for /onboarding itself and /onboarding/success)
      if (
        !onboardingComplete &&
        !req.nextUrl.pathname.startsWith("/onboarding") &&
        req.nextUrl.pathname !== "/onboarding/success"
      ) {
        return NextResponse.redirect(new URL("/onboarding", req.url));
      }
    }

    return NextResponse.next();
  },
  {
    pages: {
      signIn: "/auth/signin",
    },
  }
);

// Protect the core app pages — public pages (/, /auth/signin) remain accessible.
export const config = {
  matcher: ["/tailor/:path*", "/dashboard/:path*", "/pipeline/:path*", "/onboarding/:path*"],
};
