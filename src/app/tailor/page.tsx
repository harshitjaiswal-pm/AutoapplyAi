import ResumeUploader from "@/components/ResumeUploader";
import JobAnalyzer from "@/components/JobAnalyzer";
import TailorEngine from "@/components/TailorEngine";

/**
 * TAILOR PAGE — The main workflow page at "/tailor"
 *
 * This page brings together the three steps:
 * 1. Upload/paste resume → ResumeUploader component
 * 2. Paste job description → JobAnalyzer component
 * 3. Tailor → TailorEngine component
 *
 * Each component manages its own state through the global Zustand store,
 * so they can communicate without passing data between them directly.
 *
 * ARCHITECTURE NOTE:
 * Notice how each step is its own component in its own file.
 * This is the React way — break your UI into small, focused pieces.
 * Each component has one job. This makes code easy to read, test, and change.
 */
export default function TailorPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold text-navy">Tailor Your Resume</h1>
        <p className="mt-2 text-gray-600">
          Three steps: paste your resume, paste a job description, and let AI
          create a perfectly matched version.
        </p>
      </div>

      {/* Step 1: Resume */}
      <section className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <ResumeUploader />
      </section>

      {/* Step 2: Job Description */}
      <section className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <JobAnalyzer />
      </section>

      {/* Step 3: Tailor */}
      <section>
        <TailorEngine />
      </section>
    </div>
  );
}
