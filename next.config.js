/** @type {import('next').NextConfig} */
const nextConfig = {
  // Bake the deploy date into the client bundle so the extension zip download
  // filename always reflects exactly when this version was built/deployed.
  // Format: YYYY-MM-DD  (e.g. "2026-04-11")
  env: {
    // Format: YYYY-MM-DD-HHmm in Pacific time (e.g. "2026-04-11-1654")
    // Uses America/Vancouver so the stamp matches what Harshit sees on the clock.
    NEXT_PUBLIC_BUILD_DATE: (() => {
      const d = new Date();
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Vancouver",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d);
      const get = t => parts.find(p => p.type === t)?.value || "00";
      return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}`;
    })(),
  },
};

module.exports = nextConfig;
