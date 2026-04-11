/** @type {import('next').NextConfig} */
const nextConfig = {
  // Bake the deploy date into the client bundle so the extension zip download
  // filename always reflects exactly when this version was built/deployed.
  // Format: YYYY-MM-DD  (e.g. "2026-04-11")
  env: {
    NEXT_PUBLIC_BUILD_DATE: new Date().toISOString().slice(0, 10),
  },
};

module.exports = nextConfig;
