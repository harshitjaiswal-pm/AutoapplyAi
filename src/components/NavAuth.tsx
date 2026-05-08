"use client";

import { useSession, signIn, signOut } from "next-auth/react";

export function NavAuth() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="w-8 h-8 rounded-full bg-neutral-100 animate-pulse" />;
  }

  if (session?.user) {
    const name = session.user.name ?? "User";
    const email = session.user.email ?? "";
    const initials = name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);

    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-neutral-50 border border-neutral-100">
          <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
            {initials}
          </div>
          <div className="flex flex-col leading-tight max-w-[180px]">
            <span className="text-[12px] font-medium text-neutral-700 truncate">
              {name.split(" ")[0]}
            </span>
            {email && (
              <span className="text-[10px] text-neutral-400 font-mono truncate" title={email}>
                {email}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="text-[12px] text-neutral-400 hover:text-neutral-700 transition-colors px-2 py-1 rounded hover:bg-neutral-50"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => signIn("google")}
      className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md transition-colors"
    >
      <GoogleIcon />
      Sign in
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
