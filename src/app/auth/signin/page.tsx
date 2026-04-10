"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";

function SignInContent() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";

  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Logo mark */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center mb-5 shadow-xl shadow-indigo-200">
            <span className="text-white text-2xl font-bold tracking-tight">A</span>
          </div>
          <h1 className="text-[26px] font-bold text-neutral-900 tracking-tight text-center">
            Sign in to AutoApply
          </h1>
          <p className="mt-2 text-[14px] text-neutral-500 text-center">
            Your AI-powered job application assistant
          </p>
        </div>

        {/* Sign-in card */}
        <div className="bg-white border border-neutral-200 rounded-2xl p-7 shadow-sm">
          <button
            onClick={() => signIn("google", { callbackUrl })}
            className="w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 active:bg-neutral-100 transition-colors text-[14px] font-medium text-neutral-700 shadow-sm"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <p className="mt-6 text-center text-[11px] text-neutral-400 leading-relaxed">
            By continuing, you agree to our{" "}
            <span className="underline underline-offset-2 cursor-pointer hover:text-neutral-600 transition-colors">
              Terms
            </span>{" "}
            and{" "}
            <span className="underline underline-offset-2 cursor-pointer hover:text-neutral-600 transition-colors">
              Privacy Policy
            </span>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="min-h-[80vh]" />}>
      <SignInContent />
    </Suspense>
  );
}
