import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  return (
    <div className="animate-fade-in">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="max-w-2xl mx-auto text-center pt-16 pb-16">
        <div className="inline-flex items-center gap-2 bg-indigo-50 border border-indigo-100 rounded-full px-4 py-1.5 mb-7">
          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          <span className="text-[12px] font-medium text-indigo-700 tracking-wide">
            Greenhouse · Workday · Lever · Ashby · Easy Apply
          </span>
        </div>

        <h1 className="text-[42px] md:text-[54px] font-bold text-neutral-900 leading-[1.1] tracking-[-0.02em]">
          Apply to more jobs
          <br />
          <span className="text-indigo-600">in less time.</span>
        </h1>

        <p className="mt-5 text-[17px] text-neutral-500 leading-relaxed max-w-[480px] mx-auto">
          AutoApply scans LinkedIn, tailors your resume for each role, and fills
          every application form — automatically.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href={session ? "/dashboard" : "/auth/signin"}
            className="bg-indigo-600 text-white text-[15px] font-semibold px-8 py-3.5 rounded-xl hover:bg-indigo-700 active:bg-indigo-800 transition-colors shadow-md shadow-indigo-200"
          >
            {session ? "Go to dashboard →" : "Start applying free"}
          </Link>
          {!session && (
            <p className="text-[13px] text-neutral-400">
              No credit card &nbsp;·&nbsp; Works in Chrome
            </p>
          )}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section className="max-w-3xl mx-auto pb-12">
        <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-widest text-center mb-5">
          How it works
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 rounded-2xl overflow-hidden border border-neutral-200 shadow-sm">
          <Step
            num="1"
            title="Scan LinkedIn"
            desc="Open LinkedIn Jobs. Click Scan — AutoApply finds every job on the page in seconds."
          />
          <Step
            num="2"
            title="AI tailors your resume"
            desc="Select the roles you want. AutoApply rewrites your resume to match each job's keywords."
            border
          />
          <Step
            num="3"
            title="Forms fill automatically"
            desc="Open each application. AutoApply fills every field and attaches your resume. You review and submit."
            border
          />
        </div>
      </section>

      {/* ── Why people use it ────────────────────────────────────────── */}
      <section className="max-w-3xl mx-auto pb-20">
        <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-widest text-center mb-5">
          Why AutoApply
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ValueCard
            title="You stay in control"
            desc="AutoApply fills and tailors — you review before anything is submitted. Nothing goes out without your say."
            accent="indigo"
          />
          <ValueCard
            title="Works where you already look"
            desc="Greenhouse, Workday, Lever, Ashby, and LinkedIn Easy Apply — the platforms where real jobs live."
            accent="violet"
          />
          <ValueCard
            title="Tailored, not generic"
            desc="Your resume is rewritten for each role — not copy-pasted. Relevant keywords, relevant experience, every time."
            accent="indigo"
          />
          <ValueCard
            title="One place to track it all"
            desc="Dashboard shows every application, match score, and tailored resume. Your entire job search, organised."
            accent="violet"
          />
        </div>
      </section>
    </div>
  );
}

function Step({
  num,
  title,
  desc,
  border,
}: {
  num: string;
  title: string;
  desc: string;
  border?: boolean;
}) {
  return (
    <div
      className={`bg-white p-7 ${border ? "border-l border-neutral-200" : ""}`}
    >
      <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center mb-4">
        <span className="text-white text-xs font-bold">{num}</span>
      </div>
      <h3 className="text-[15px] font-semibold text-neutral-900 mb-2">{title}</h3>
      <p className="text-[13px] text-neutral-500 leading-relaxed">{desc}</p>
    </div>
  );
}

function ValueCard({
  title,
  desc,
  accent,
}: {
  title: string;
  desc: string;
  accent: "indigo" | "violet";
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-6 hover:bg-white hover:shadow-sm transition-all">
      <div
        className={`w-2 h-2 rounded-full mb-4 ${
          accent === "indigo" ? "bg-indigo-500" : "bg-violet-500"
        }`}
      />
      <h3 className="text-[15px] font-semibold text-neutral-900 mb-1.5">{title}</h3>
      <p className="text-[13px] text-neutral-500 leading-relaxed">{desc}</p>
    </div>
  );
}
