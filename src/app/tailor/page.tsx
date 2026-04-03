import ResumeUploader from "@/components/ResumeUploader";
import JobAnalyzer from "@/components/JobAnalyzer";
import TailorEngine from "@/components/TailorEngine";

export default function TailorPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 space-y-10 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">
          Tailor your resume
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Upload your resume, paste a job description, and let AI do the rest.
        </p>
      </div>

      <section className="border border-neutral-200 rounded-xl p-6">
        <ResumeUploader />
      </section>

      <section className="border border-neutral-200 rounded-xl p-6">
        <JobAnalyzer />
      </section>

      <section>
        <TailorEngine />
      </section>
    </div>
  );
}
