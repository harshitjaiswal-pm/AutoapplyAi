import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: {
    signIn: "/auth/signin",
  },
});

// Protect the core app pages — public pages (/, /auth/signin) remain accessible.
export const config = {
  matcher: ["/tailor/:path*", "/dashboard/:path*", "/pipeline/:path*"],
};
