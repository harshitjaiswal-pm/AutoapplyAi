"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";

export function NavLinks() {
  const { data: session, status } = useSession();

  if (status === "loading" || !session) return null;

  return (
    <div className="flex items-center gap-0.5">
      <NavLink href="/dashboard">Dashboard</NavLink>
      <NavLink href="/applications">Submissions</NavLink>
      <NavLink href="/tailor">Tailor resume</NavLink>
    </div>
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
      className="px-3 py-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-900 rounded-lg hover:bg-neutral-100/70 transition-colors"
    >
      {children}
    </Link>
  );
}
