"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function SignInContent() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/tailor";

  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-200">
            <span className="text-white text-xl font-bold">A</span>
          </div>
          <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">
            Welcome to AutoApply
          </h1>
          <p className="mt-2 text-sm text-neutral-500 text-center">
            Sign in to tailor your resume and track your applications.
          </p>
        </div>

        {/* Sign-in card */}
        <div className="bg-white border border-neutral-200 rounded-2xl p-8 shadow-sm">
          <button
            onClick={() => signIn("google", { callbackUrl })}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-neutral-200 bg-white hover:bg-neutral-50 active:bg-neutral-100 transition-colors text-sm font-medium text-neutral-700 shadow-sm"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <p className="mt-6 text-center text-[11px] text-neutral-400 leading-relaxed">
            By signing in, you agree to our{" "}
            <span className="underline cursor-pointer">Terms of Service</span>
            {" "}and{" "}
            <span className="underline cursor-pointer">Privacy Policy</span>.
          </p>
        </div>

        {/* Feature highlights */}
        <div className="mt-8 space-y-3">
          <FeatureRow icon="✦" text="AI-tailored resume for every job posting" />
          <FeatureRow icon="✦" text="ATS-optimized keywords and formatting" />
          <FeatureRow icon="✦" text="Track applications and match scores" />
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function FeatureRow({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-indigo-400 text-[10px]">{icon}</span>
      <span className="text-[13px] text-neutral-500">{text}</span>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="min-h-[80vh]" />}>
      <SignInContent />
    </Suspense>
  );
}
