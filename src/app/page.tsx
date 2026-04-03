import Link from "next/link";

/**
 * HOME PAGE - The landing page at "/"
 *
 * This is the first thing users see. It explains what the tool does
 * and gives them a clear call to action: "Start Tailoring"
 *
 * In React, we build UI as "components" — functions that return HTML-like code (called JSX).
 * The className="" attributes are Tailwind CSS utility classes.
 * Each class does one thing: "text-4xl" = large text, "font-bold" = bold, "mt-8" = margin-top 8 units.
 */
export default function HomePage() {
  return (
    <div className="max-w-3xl mx-auto text-center py-16">
      {/* Hero section */}
      <h1 className="text-5xl font-bold text-navy leading-tight">
        Stop Applying.
        <br />
        <span className="text-brand-500">Start Getting Hired.</span>
      </h1>

      <p className="mt-6 text-lg text-gray-600 leading-relaxed">
        AutoApply AI tailors your resume for every job in seconds, not hours.
        Paste a job description, get a perfectly matched resume — with the right
        keywords, reordered experience, and rewritten bullets.
      </p>

      {/* How it works - 3 steps */}
      <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8">
        <StepCard
          step="1"
          title="Upload Resume"
          description="Upload your master resume once. AI parses it into structured data — skills, experience, projects."
        />
        <StepCard
          step="2"
          title="Paste Job Description"
          description="Copy any job posting. AI analyzes requirements, keywords, and what the company really wants."
        />
        <StepCard
          step="3"
          title="Get Tailored Resume"
          description="AI rewrites your resume for that specific job. Download as PDF. Apply in seconds."
        />
      </div>

      {/* Call to action */}
      <div className="mt-12">
        <Link
          href="/tailor"
          className="inline-block bg-brand-500 hover:bg-brand-600 text-white font-semibold px-8 py-4 rounded-lg text-lg transition-colors shadow-md"
        >
          Start Tailoring Your Resume
        </Link>
      </div>

      {/* Value prop */}
      <div className="mt-16 bg-brand-50 rounded-xl p-8 text-left">
        <h2 className="text-xl font-semibold text-navy mb-4">
          Why AutoApply instead of ChatGPT?
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-700">
          <div className="flex items-start gap-3">
            <span className="text-brand-500 font-bold mt-0.5">1.</span>
            <span>
              <strong>Persistent memory.</strong> Your profile is saved. No
              re-uploading every time.
            </span>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-brand-500 font-bold mt-0.5">2.</span>
            <span>
              <strong>Purpose-built.</strong> Prompts are optimized for resume
              tailoring, not general chat.
            </span>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-brand-500 font-bold mt-0.5">3.</span>
            <span>
              <strong>One-click PDF export.</strong> Download a formatted,
              ATS-friendly resume instantly.
            </span>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-brand-500 font-bold mt-0.5">4.</span>
            <span>
              <strong>Application tracker.</strong> See every job you applied to
              in one dashboard.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * StepCard - A reusable component for the "How it works" section.
 *
 * KEY CONCEPT: Components are just functions that accept "props" (arguments)
 * and return JSX. This is the fundamental building block of React.
 */
function StepCard({
  step,
  title,
  description,
}: {
  step: string;
  title: string;
  description: string;
}) {
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <div className="w-10 h-10 bg-brand-500 text-white rounded-full flex items-center justify-center font-bold text-lg mx-auto">
        {step}
      </div>
      <h3 className="mt-4 font-semibold text-navy">{title}</h3>
      <p className="mt-2 text-sm text-gray-600">{description}</p>
    </div>
  );
}
