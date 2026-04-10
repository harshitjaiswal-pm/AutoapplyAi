import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { Providers } from "./providers";
import { NavAuth } from "@/components/NavAuth";
import { NavLinks } from "@/components/NavLinks";

export const metadata: Metadata = {
  title: "AutoApply — Apply to more jobs, in less time",
  description:
    "AutoApply scans LinkedIn, tailors your resume for each role, and fills every application form — automatically. Works on Greenhouse, Workday, Lever, Ashby, and Easy Apply.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white">
        <Providers>
          {/* Nav */}
          <nav className="fixed top-0 w-full z-50 bg-white/85 backdrop-blur-xl border-b border-neutral-100/80">
            <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
              <Link href="/" className="flex items-center gap-2 group">
                <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center shadow-sm shadow-indigo-200 group-hover:bg-indigo-500 transition-colors">
                  <span className="text-white text-xs font-bold tracking-tight">A</span>
                </div>
                <span className="text-sm font-semibold text-neutral-900 tracking-tight">
                  AutoApply
                </span>
              </Link>

              <NavLinks />

              <NavAuth />
            </div>
          </nav>

          {/* Spacer for fixed nav */}
          <div className="h-14" />

          <main className="max-w-6xl mx-auto px-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}

