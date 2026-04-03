import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "AutoApply AI",
  description: "Tailor your resume for every job in seconds.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white">
        {/* Nav */}
        <nav className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-xl border-b border-neutral-100">
          <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-6 h-6 bg-indigo-600 rounded-md flex items-center justify-center">
                <span className="text-white text-xs font-bold">A</span>
              </div>
              <span className="text-sm font-semibold text-neutral-900 tracking-tight">
                AutoApply
              </span>
            </Link>

            <div className="flex items-center gap-1">
              <NavLink href="/">Home</NavLink>
              <NavLink href="/tailor">Tailor</NavLink>
              <NavLink href="/dashboard">Dashboard</NavLink>
            </div>
          </div>
        </nav>

        {/* Spacer for fixed nav */}
        <div className="h-14" />

        <main className="max-w-5xl mx-auto px-6">{children}</main>
      </body>
    </html>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 text-[13px] text-neutral-500 hover:text-neutral-900 rounded-md hover:bg-neutral-50 transition-colors"
    >
      {children}
    </Link>
  );
}
