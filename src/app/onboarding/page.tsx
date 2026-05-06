"use client";

import { useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useAppStore } from "@/store/useAppStore";
import { useCallback } from "react";

interface ResumeUploadResponse {
  text: string;
}

interface ParsedResumeResponse {
  contactInfo: { name?: string; email?: string };
  experience: { role?: string; company?: string }[];
  skills: { technical?: string[] };
}

function OnboardingContent() {
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEditMode = searchParams.get("edit") === "profile";
  const isResumeEditMode = searchParams.get("edit") === "resume";

  const [step, setStep] = useState(isEditMode ? 4 : isResumeEditMode ? 3 : 1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    userProfile,
    setUserProfile,
    setParsedResumeSummary,
    parsedResumeSummary,
    setOnboardingComplete,
    setRawResumeText,
    setPipelineResumeText,
    setPipelineParsedResume,
  } = useAppStore();

  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);

  const defaultProfile = {
    firstName: "",
    lastName: "",
    email: session?.user?.email || "",
    phone: "",
    city: "",
    province: "",
    address: "",
    postalCode: "",
    linkedin: "",
    github: "",
    portfolio: "",
    currentCompany: "",
    pronouns: "",
    requireSponsorship: "no" as const,
    salaryExpectation: "",
  };

  const [formData, setFormData] = useState(userProfile || defaultProfile);

  const handleResumeUpload = useCallback(
    async (file: File) => {
      setResumeLoading(true);
      setError(null);
      try {
        // Upload resume
        const uploadFormData = new FormData();
        uploadFormData.append("file", file);
        const uploadRes = await fetch("/api/upload-resume", {
          method: "POST",
          body: uploadFormData,
        });

        if (!uploadRes.ok) {
          throw new Error("Failed to upload resume");
        }

        const uploadData = (await uploadRes.json()) as ResumeUploadResponse;

        // Parse resume
        const parseRes = await fetch("/api/parse-resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resumeText: uploadData.text }),
        });

        if (!parseRes.ok) {
          throw new Error("Failed to parse resume");
        }

        const parseData = (await parseRes.json()) as ParsedResumeResponse;

        // Extract summary
        const jobCount = parseData.experience?.length || 0;
        const skillCount = parseData.skills?.technical?.length || 0;
        const name = parseData.contactInfo?.name || "";

        setParsedResumeSummary({
          name,
          jobCount,
          skillCount,
        });

        // Store full resume text + parsed object in Zustand so dashboard & pipeline can use them
        setRawResumeText(uploadData.text);
        setPipelineResumeText(uploadData.text);
        setPipelineParsedResume(parseData as Parameters<typeof setPipelineParsedResume>[0]);

        // Write to localStorage so the pipeline-bridge can sync to the extension immediately
        if (typeof window !== "undefined") {
          window.localStorage.setItem("autoapply-parsed-resume", JSON.stringify(parseData));
          window.dispatchEvent(
            new CustomEvent("autoapply-sync-resume", {
              detail: { parsedResume: parseData },
            })
          );
        }

        // Save to server so resume is available on any device
        try {
          await fetch("/api/user/resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resumeText: uploadData.text,
              parsedResume: parseData,
              parsedResumeSummary: { name, jobCount, skillCount },
            }),
          });
        } catch (e) {
          // Non-fatal — resume is already in localStorage, server save is best-effort
          console.warn("AutoApply: Failed to save resume to server", e);
        }

        // Pre-fill form fields
        if (name && !userProfile?.firstName) {
          const [first, ...rest] = name.split(" ");
          setFormData((prev) => ({
            ...prev,
            firstName: first || "",
            lastName: rest.join(" ") || "",
          }));
        }

        if (parseData.contactInfo?.email && !userProfile?.email) {
          setFormData((prev) => ({
            ...prev,
            email: parseData.contactInfo?.email || "",
          }));
        }

        setResumeFile(file);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to process resume"
        );
      } finally {
        setResumeLoading(false);
      }
    },
    [setParsedResumeSummary, setRawResumeText, setPipelineResumeText, setPipelineParsedResume, userProfile?.firstName, userProfile?.email]
  );

  const handleSaveProfile = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Validate required fields
      if (!formData.firstName || !formData.lastName || !formData.email) {
        setError("Please fill in all required fields (name and email)");
        setIsLoading(false);
        return;
      }

      // Save to Zustand
      setUserProfile(formData);

      // Create profile for extension storage
      const profileForExtension = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        phone: formData.phone,
        address: formData.address,
        city: formData.city,
        province: formData.province,
        postalCode: formData.postalCode,
        linkedin: formData.linkedin,
        github: formData.github,
        portfolio: formData.portfolio,
        currentCompany: formData.currentCompany,
        pronouns: formData.pronouns,
        requireSponsorship:
          formData.requireSponsorship === "yes" ? "yes" : "no",
        howDidYouHear: "",
        ethnicity: "",
        gender: "",
        disabilityStatus: "",
        veteranStatus: "",
      };

      // Persist profile to server (Redis) so it survives logout/new devices
      try {
        await fetch("/api/user/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
      } catch (e) {
        console.warn("AutoApply: Failed to save profile to server", e);
        // Non-blocking — continue even if server save fails
      }

      // Write to localStorage for extension to sync
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          "aa_profile",
          JSON.stringify(profileForExtension)
        );

        // Set cookie for middleware
        document.cookie =
          "aa_onboarding_complete=true; path=/; max-age=31536000";
      }

      // Update store and redirect
      setOnboardingComplete(true);

      if (isEditMode) {
        router.push("/dashboard");
      } else {
        router.push("/onboarding/success");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save profile"
      );
    } finally {
      setIsLoading(false);
    }
  };

  if (!session) {
    return <div className="py-20 text-center text-neutral-400">Loading…</div>;
  }

  const STEPS = ["Welcome", "Install", "Resume", "Profile"];

  return (
    <div className="min-h-screen bg-white py-10">
      <div className="max-w-xl mx-auto px-6">
        {/* Progress indicator */}
        {!isEditMode && !isResumeEditMode && (
          <div className="mb-10">
            <div className="flex items-center gap-0">
              {STEPS.map((label, idx) => {
                const i = idx + 1;
                const done = i < step;
                const active = i === step;
                return (
                  <div key={label} className="flex items-center flex-1 last:flex-none">
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                          done
                            ? "bg-indigo-600 text-white"
                            : active
                            ? "bg-indigo-600 text-white ring-4 ring-indigo-100"
                            : "bg-neutral-100 text-neutral-400"
                        }`}
                      >
                        {done ? "✓" : i}
                      </div>
                      <span className={`mt-1.5 text-[10px] font-medium whitespace-nowrap ${active ? "text-indigo-700" : "text-neutral-400"}`}>
                        {label}
                      </span>
                    </div>
                    {idx < STEPS.length - 1 && (
                      <div className={`flex-1 h-0.5 mx-1 mb-4 transition-all ${i < step ? "bg-indigo-600" : "bg-neutral-100"}`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 1: Welcome */}
        {step === 1 && (
          <div className="space-y-8 animate-fade-in">
            <div className="space-y-3">
              <h1 className="text-[32px] font-bold text-neutral-900 tracking-tight">
                You're almost ready.
              </h1>
              <p className="text-[16px] text-neutral-500 leading-relaxed">
                Let's get AutoApply set up in 3 quick steps — takes about 2 minutes.
              </p>
            </div>

            <div className="space-y-3">
              <SetupStep num="1" title="Install the Chrome extension" desc="Works on LinkedIn and every major job application site." />
              <SetupStep num="2" title="Upload your resume" desc="AutoApply reads it once and uses it for every application." />
              <SetupStep num="3" title="Fill in your details" desc="Name, contact info, and preferences — so forms fill themselves." />
            </div>

            <button
              onClick={() => setStep(2)}
              className="w-full bg-indigo-600 text-white font-semibold py-3.5 rounded-xl hover:bg-indigo-700 active:bg-indigo-800 transition-colors"
            >
              Get started →
            </button>
          </div>
        )}

        {/* Step 2: Install Extension */}
        {step === 2 && (
          <div className="space-y-8 animate-fade-in">
            <div className="space-y-2">
              <h1 className="text-[32px] font-bold text-neutral-900 tracking-tight">
                Add AutoApply to Chrome
              </h1>
              <p className="text-[15px] text-neutral-500">
                The extension runs on LinkedIn and every job application page — it's what does the work.
              </p>
            </div>

            {/* Direct download — replace with Chrome Web Store link once the listing is live */}
            <a
              href="/autoapply-extension.zip"
              download="autoapply-extension.zip"
              className="flex items-center justify-center gap-2.5 w-full bg-indigo-600 text-white text-[15px] font-semibold py-4 rounded-xl hover:bg-indigo-700 active:bg-indigo-800 transition-colors shadow-lg shadow-indigo-200"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="1.5" opacity="0.4"/>
                <path d="M12 8v8M8 12l4 4 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Download AutoApply Extension
            </a>

            <div className="rounded-xl border border-neutral-100 divide-y divide-neutral-100">
              <InstallStep num="1" text="Download the zip above and unzip it to a permanent folder on your computer (don't delete it after)." />
              <InstallStep num="2" text='Open Chrome and go to chrome://extensions. Turn on "Developer mode" (top-right toggle), then click "Load unpacked" and select the unzipped folder.' />
              <InstallStep num="3" text='Pin AutoApply from the extensions toolbar (puzzle piece icon), then come back here and continue.' />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(1)}
                className="px-5 text-neutral-500 font-medium py-3.5 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep(3)}
                className="flex-1 bg-indigo-600 text-white font-semibold py-3.5 rounded-xl hover:bg-indigo-700 active:bg-indigo-800 transition-colors"
              >
                I've installed it →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Upload Resume */}
        {step === 3 && (
          <div className="space-y-8 animate-fade-in">
            <div className="space-y-2">
              {isResumeEditMode ? (
                <>
                  <h1 className="text-3xl font-bold text-neutral-900">
                    Change Your Resume
                  </h1>
                  <p className="text-neutral-500">
                    Upload a new PDF — it replaces your current resume immediately
                  </p>
                </>
              ) : (
                <>
                  <h1 className="text-3xl font-bold text-neutral-900">
                    Upload Your Resume
                  </h1>
                  <p className="text-neutral-500">
                    We'll read it to auto-fill your work history on every
                    application
                  </p>
                </>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-[13px] text-red-800">
                {error}
              </div>
            )}

            {/* In resume-edit mode: always show drop zone first, then success once uploaded */}
            {(!parsedResumeSummary || isResumeEditMode) && !resumeFile ? (
              <ResumeDropZone
                onFile={handleResumeUpload}
                isLoading={resumeLoading}
              />
            ) : parsedResumeSummary ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-full bg-emerald-500 flex items-center justify-center shrink-0 mt-0.5">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M2.5 7l3 3 6-6" stroke="white" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-neutral-900">
                      {resumeFile?.name || "resume.pdf"}
                    </p>
                    <div className="grid grid-cols-2 gap-4 mt-3 text-[13px]">
                      <div>
                        <p className="text-neutral-500">Name detected</p>
                        <p className="font-medium text-neutral-900">
                          {parsedResumeSummary.name}
                        </p>
                      </div>
                      <div>
                        <p className="text-neutral-500">Work experience</p>
                        <p className="font-medium text-neutral-900">
                          {parsedResumeSummary.jobCount} jobs found
                        </p>
                      </div>
                      <div>
                        <p className="text-neutral-500">Skills</p>
                        <p className="font-medium text-neutral-900">
                          {parsedResumeSummary.skillCount} skills found
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setResumeFile(null);
                    setParsedResumeSummary(null);
                  }}
                  className="w-full text-center text-[13px] text-emerald-700 font-medium py-2 hover:bg-emerald-100 rounded transition-colors"
                >
                  Upload different resume
                </button>
              </div>
            ) : null}

            <div className="flex gap-3">
              {isResumeEditMode ? (
                <button
                  onClick={() => router.push("/dashboard")}
                  className="flex-1 text-indigo-600 font-medium py-3 rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors"
                >
                  ← Back to Dashboard
                </button>
              ) : (
                <button
                  onClick={() => setStep(2)}
                  className="flex-1 text-indigo-600 font-medium py-3 rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors"
                >
                  ← Back
                </button>
              )}
              <button
                onClick={() => {
                  if (isResumeEditMode) {
                    router.push("/dashboard");
                  } else {
                    setStep(4);
                  }
                }}
                disabled={!parsedResumeSummary}
                className="flex-1 bg-indigo-600 text-white font-medium py-3 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isResumeEditMode ? "Save & Back to Dashboard →" : "Looks Good →"}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Profile */}
        {step === 4 && (
          <div className="space-y-7 animate-fade-in">
            <div className="space-y-2">
              <h1 className="text-[32px] font-bold text-neutral-900 tracking-tight">
                {isEditMode ? "Edit your profile" : "Your details"}
              </h1>
              <p className="text-[15px] text-neutral-500">
                These fill in automatically on every application form.
              </p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-[13px] text-red-700">
                {error}
              </div>
            )}

            <div className="space-y-6">
              {/* Contact */}
              <div>
                <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-3">Contact</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name" required>
                    <input type="text" value={formData.firstName} onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} placeholder="Harshit" className={inputCls} />
                  </Field>
                  <Field label="Last name" required>
                    <input type="text" value={formData.lastName} onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} placeholder="Singh" className={inputCls} />
                  </Field>
                  <Field label="Email" required>
                    <input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} placeholder="you@example.com" className={inputCls} />
                  </Field>
                  <Field label="Phone" required>
                    <input type="tel" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} placeholder="+1 (555) 000-0000" className={inputCls} />
                  </Field>
                </div>
              </div>

              {/* Location */}
              <div>
                <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-3">Location</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Street address">
                    <input type="text" value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} placeholder="123 Main St" className={inputCls} />
                  </Field>
                  <Field label="Postal code">
                    <input type="text" value={formData.postalCode} onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })} placeholder="M5V 2H1" className={inputCls} />
                  </Field>
                  <Field label="City">
                    <input type="text" value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} placeholder="Toronto" className={inputCls} />
                  </Field>
                  <Field label="Province / State">
                    <input type="text" value={formData.province} onChange={(e) => setFormData({ ...formData, province: e.target.value })} placeholder="Ontario" className={inputCls} />
                  </Field>
                </div>
              </div>

              {/* Online presence */}
              <div>
                <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-3">Online</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="LinkedIn">
                    <input type="text" value={formData.linkedin} onChange={(e) => setFormData({ ...formData, linkedin: e.target.value })} placeholder="linkedin.com/in/you" className={inputCls} />
                  </Field>
                  <Field label="GitHub">
                    <input type="text" value={formData.github} onChange={(e) => setFormData({ ...formData, github: e.target.value })} placeholder="github.com/you" className={inputCls} />
                  </Field>
                  <Field label="Portfolio / Website">
                    <input type="text" value={formData.portfolio} onChange={(e) => setFormData({ ...formData, portfolio: e.target.value })} placeholder="yoursite.com" className={inputCls} />
                  </Field>
                  <Field label="Most recent employer">
                    <input type="text" value={formData.currentCompany} onChange={(e) => setFormData({ ...formData, currentCompany: e.target.value })} placeholder="Acme Corp" className={inputCls} />
                  </Field>
                </div>
              </div>

              {/* Application preferences */}
              <div>
                <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-3">Preferences</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Work authorization">
                    <select value={formData.requireSponsorship} onChange={(e) => setFormData({ ...formData, requireSponsorship: e.target.value })} className={inputCls}>
                      <option value="no">Authorized — no sponsorship needed</option>
                      <option value="yes">Need work visa / sponsorship</option>
                    </select>
                  </Field>
                  <Field label="Salary expectation">
                    <input type="text" value={formData.salaryExpectation} onChange={(e) => setFormData({ ...formData, salaryExpectation: e.target.value })} placeholder="e.g. $120,000" className={inputCls} />
                  </Field>
                  <Field label="Pronouns">
                    <select value={formData.pronouns} onChange={(e) => setFormData({ ...formData, pronouns: e.target.value })} className={inputCls}>
                      <option value="">Prefer not to say</option>
                      <option value="He/Him">He/Him</option>
                      <option value="She/Her">She/Her</option>
                      <option value="They/Them">They/Them</option>
                      <option value="Other">Other</option>
                    </select>
                  </Field>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              {!isEditMode && (
                <button
                  onClick={() => setStep(3)}
                  className="px-5 text-neutral-500 font-medium py-3.5 rounded-xl border border-neutral-200 hover:bg-neutral-50 transition-colors"
                >
                  ← Back
                </button>
              )}
              <button
                onClick={handleSaveProfile}
                disabled={isLoading}
                className="flex-1 bg-indigo-600 text-white font-semibold py-3.5 rounded-xl hover:bg-indigo-700 active:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isLoading ? "Saving…" : isEditMode ? "Save changes →" : "Save & finish →"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white py-10" />}>
      <OnboardingContent />
    </Suspense>
  );
}

const inputCls =
  "w-full px-3.5 py-2.5 border border-neutral-200 rounded-lg text-[14px] text-neutral-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-colors placeholder:text-neutral-300 bg-white";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[12px] font-medium text-neutral-600">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function SetupStep({ num, title, desc }: { num: string; title: string; desc: string }) {
  return (
    <div className="flex gap-4 p-4 rounded-xl border border-neutral-100 bg-neutral-50/50">
      <div className="w-7 h-7 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
        {num}
      </div>
      <div>
        <p className="text-[14px] font-semibold text-neutral-900">{title}</p>
        <p className="text-[13px] text-neutral-500 mt-0.5">{desc}</p>
      </div>
    </div>
  );
}

function InstallStep({ num, text }: { num: string; text: string }) {
  return (
    <div className="flex gap-4 px-5 py-4">
      <span className="text-[12px] font-bold text-indigo-400 mt-0.5 shrink-0">{num}</span>
      <p className="text-[14px] text-neutral-600 leading-relaxed">{text}</p>
    </div>
  );
}

function FeatureItem({
  emoji,
  title,
  desc,
}: {
  emoji: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex gap-4">
      <span className="text-2xl shrink-0">{emoji}</span>
      <div>
        <p className="font-medium text-neutral-900">{title}</p>
        <p className="text-[13px] text-neutral-600 mt-1">{desc}</p>
      </div>
    </div>
  );
}

function ResumeDropZone({
  onFile,
  isLoading,
}: {
  onFile: (file: File) => void;
  isLoading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.add("bg-indigo-50");
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.currentTarget.classList.remove("bg-indigo-50");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("bg-indigo-50");

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.type === "application/pdf" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || file.name.endsWith(".docx")) {
        onFile(file);
      }
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFile(e.target.files[0]);
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className="border-2 border-dashed border-neutral-300 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/50 transition-colors"
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx"
        onChange={handleFileInput}
        className="hidden"
      />

      {isLoading ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-[14px] font-medium text-neutral-700">
            Reading your resume…
          </p>
          <p className="text-[12px] text-neutral-400">This takes a few seconds</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="w-12 h-12 bg-indigo-50 rounded-xl flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M14 2v6h6M12 12v6M9 15l3-3 3 3" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="space-y-1 text-center">
            <p className="text-[14px] font-semibold text-neutral-800">
              Drop your resume here
            </p>
            <p className="text-[13px] text-neutral-400">
              or <span className="text-indigo-600 font-medium">click to browse</span> — PDF or Word (.docx)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
