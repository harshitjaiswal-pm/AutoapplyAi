import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

// This metadata shows up in the browser tab and in Google search results
export const metadata: Metadata = {
  title: "AutoApply AI",
  description: "AI-powered job application tool. Tailor resumes at scale.",
};

/**
 * RootLayout wraps EVERY page in our app.
 * Think of it as the "frame" — the navbar stays the same,
 * and {children} is swapped out as you navigate between pages.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900">
        {/* ===== NAVIGATION BAR ===== */}
        <nav className="bg-navy text-white shadow-lg">
          <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
            {/* Logo / Home link */}
            <Link href="/" className="text-xl font-bold tracking-tight">
              AutoApply<span className="text-brand-100"> AI</span>
            </Link>

            {/* Navigation links */}
            <div className="flex gap-6 text-sm">
              <Link
                href="/"
                className="hover:text-brand-100 transition-colors"
              >
                Home
              </Link>
              <Link
                href="/tailor"
                className="hover:text-brand-100 transition-colors"
              >
                Tailor Resume
              </Link>
              <Link
                href="/dashboard"
                className="hover:text-brand-100 transition-colors"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </nav>

        {/* ===== PAGE CONTENT ===== */}
        <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
