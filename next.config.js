/** @type {import('next').NextConfig} */
const nextConfig = {
  // Bake the deploy date into the client bundle so the extension zip download
  // filename always reflects exactly when this version was built/deployed.
  // Format: YYYY-MM-DD  (e.g. "2026-04-11")
  env: {
    // Format: YYYY-MM-DD-HHmm  (e.g. "2026-04-11-1430")
    NEXT_PUBLIC_BUILD_DATE: (() => {
      const d = new Date();
      const date = d.toISOString().slice(0, 10);
      const hh   = String(d.getUTCHours()).padStart(2, "0");
      const mm   = String(d.getUTCMinutes()).padStart(2, "0");
      return `${date}-${hh}${mm}`;
    })(),
  },
};

module.exports = nextConfig;
