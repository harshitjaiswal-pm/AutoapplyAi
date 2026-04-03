import Link from "next/link";

export default function HomePage() {
  return (
    <div className="py-24 animate-fade-in">
      {/* Hero */}
      <section className="max-w-2xl mx-auto text-center mb-24">
        <p className="text-[13px] font-medium text-indigo-500 tracking-wide uppercase mb-4">
          AI Resume Tailoring
        </p>
        <h1 className="text-4xl md:text-5xl font-bold text-neutral-900 leading-[1.15] tracking-tight">
          Stop applying blindly.
          <br />
          <span className="text-indigo-400">Get the interview.</span>
        </h1>
        <p className="mt-5 text-base text-neutral-500 leading-relaxed max-w-md mx-auto">
          Paste a job description. Get a tailored, ATS-optimized resume
          in seconds. Download and apply.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/tailor"
            className="bg-indigo-600 text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Start tailoring
          </Link>
          <Link
            href="/dashboard"
            className="text-sm text-neutral-500 hover:text-neutral-900 px-4 py-2.5 border border-neutral-200 rounded-lg hover:border-neutral-300 transition-colors"
          >
            View dashboard
          </Link>
        </div>
      </section>

      {/* Steps */}
      <section className="max-w-3xl mx-auto mb-24">
        <p className="text-[13px] font-medium text-neutral-400 uppercase tracking-wide mb-6">
          How it works
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StepCard
            num="01"
            title="Upload resume"
            desc="Upload or paste your master resume. AI extracts skills, experience, and structure."
            color="bg-indigo-50 border-indigo-100"
            numColor="text-indigo-400"
          />
          <StepCard
            num="02"
            title="Paste the job"
            desc="Copy any job posting. AI pulls out requirements, keywords, and what matters."
            color="bg-violet-50 border-violet-100"
            numColor="text-violet-400"
          />
          <StepCard
            num="03"
            title="Get matched"
            desc="AI tailors your resume for that specific role. Download as PDF or Word."
            color="bg-purple-50 border-purple-100"
            numColor="text-purple-400"
          />
        </div>
      </section>

      {/* Why */}
      <section className="max-w-3xl mx-auto mb-16">
        <p className="text-[13px] font-medium text-neutral-400 uppercase tracking-wide mb-6">
          Why AutoApply
        </p>
        <div className="bg-neutral-50 rounded-xl border border-neutral-100 divide-y divide-neutral-100">
          <Row icon="01" title="Not a chatbot" desc="Purpose-built prompts tuned by career coaches for PM and BA roles. Not a generic AI conversation." />
          <Row icon="02" title="ATS-first" desc="Every resume is optimized for applicant tracking systems — right keywords, right format, right structure." />
          <Row icon="03" title="One-click export" desc="Download a formatted PDF or Word doc instantly. No copy-pasting into templates." />
          <Row icon="04" title="Track everything" desc="Dashboard shows every job you tailored for, match scores, and application status." />
        </div>
      </section>
    </div>
  );
}

function StepCard({
  num,
  title,
  desc,
  color,
  numColor,
}: {
  num: string;
  title: string;
  desc: string;
  color: string;
  numColor: string;
}) {
  return (
    <div className={`rounded-xl p-5 border ${color}`}>
      <span className={`text-xs font-mono font-semibold ${numColor}`}>{num}</span>
      <h3 className="mt-3 text-sm font-semibold text-neutral-900">{title}</h3>
      <p className="mt-2 text-[13px] text-neutral-500 leading-relaxed">{desc}</p>
    </div>
  );
}

function Row({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-4 px-5 py-4">
      <span className="text-[11px] font-mono font-semibold text-indigo-400 mt-0.5 shrink-0">{icon}</span>
      <div>
        <p className="text-sm font-medium text-neutral-900">{title}</p>
        <p className="text-[13px] text-neutral-500 mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}
