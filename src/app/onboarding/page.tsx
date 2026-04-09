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

  const [step, setStep] = useState(isEditMode ? 4 : 1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    userProfile,
    setUserProfile,
    setParsedResumeSummary,
    parsedResumeSummary,
    setOnboardingComplete,
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
    [setParsedResumeSummary, userProfile?.firstName, userProfile?.email]
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
    return <div className="py-20 text-center">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-white py-10">
      <div className="max-w-2xl mx-auto px-6">
        {/* Progress bar */}
        {!isEditMode && (
          <div className="mb-12">
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-sm font-semibold text-neutral-900">
                  Step {step} of 4
                </p>
                <p className="text-[13px] text-neutral-500 mt-1">
                  {step === 1
                    ? "Welcome"
                    : step === 2
                    ? "Install Extension"
                    : step === 3
                    ? "Upload Resume"
                    : "Complete Profile"}
                </p>
              </div>
            </div>
            <div className="w-full bg-neutral-100 rounded-full h-2 overflow-hidden">
              <div
                className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(step / 4) * 100}%` }}
              />
            </div>

            {/* Progress dots */}
            <div className="flex gap-2 mt-6">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={`h-2 w-2 rounded-full transition-all ${
                    i <= step ? "bg-indigo-600" : "bg-neutral-200"
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Step 1: Welcome */}
        {step === 1 && (
          <div className="space-y-8 animate-fade-in">
            <div className="text-center space-y-4">
              <h1 className="text-3xl md:text-4xl font-bold text-neutral-900">
                Welcome to AutoApply AI
              </h1>
              <p className="text-neutral-500 max-w-md mx-auto">
                Get ready to transform your job search with AI-powered
                automation.
              </p>
            </div>

            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-8 space-y-4">
              <FeatureItem
                emoji="🔗"
                title="Scan LinkedIn Job Listings Instantly"
                desc="Find and extract job opportunities from LinkedIn with a single click."
              />
              <FeatureItem
                emoji="✨"
                title="AI Tailors Your Resume"
                desc="Our AI customizes your resume for each role with relevant keywords and experience."
              />
              <FeatureItem
                emoji="📝"
                title="Forms Fill Automatically"
                desc="Application forms populate with your information — just review and submit."
              />
            </div>

            <button
              onClick={() => setStep(2)}
              className="w-full bg-indigo-600 text-white font-medium py-3 rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Let's get you set up →
            </button>
          </div>
        )}

        {/* Step 2: Install Extension */}
        {step === 2 && (
          <div className="space-y-8 animate-fade-in">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-neutral-900">
                Install the Chrome Extension
              </h1>
              <p className="text-neutral-500">
                AutoApply AI works through a Chrome extension on LinkedIn and
                job application pages.
              </p>
            </div>

            <a
              href="https://chrome.google.com/webstore/detail/autoapply-ai-automated-jo/menddlokdcmfeagbmejmogijhigcplgc"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full bg-indigo-600 text-white text-center font-medium py-4 rounded-xl hover:bg-indigo-700 transition-colors"
            >
              Add to Chrome →
            </a>

            <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-6 space-y-3">
              <p className="text-sm font-semibold text-neutral-900">
                Step-by-step installation:
              </p>
              <ol className="space-y-3 text-[13px] text-neutral-600">
                <li className="flex gap-3">
                  <span className="font-semibold text-neutral-900 min-w-fit">
                    1.
                  </span>
                  <span>Click "Add to Chrome" above</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-neutral-900 min-w-fit">
                    2.
                  </span>
                  <span>Click "Add Extension" in the popup</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-neutral-900 min-w-fit">
                    3.
                  </span>
                  <span>
                    Pin it to your toolbar (click the puzzle piece icon → pin
                    AutoApply)
                  </span>
                </li>
              </ol>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(1)}
                className="flex-1 text-indigo-600 font-medium py-3 rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep(3)}
                className="flex-1 bg-indigo-600 text-white font-medium py-3 rounded-lg hover:bg-indigo-700 transition-colors"
              >
                I've Installed It →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Upload Resume */}
        {step === 3 && (
          <div className="space-y-8 animate-fade-in">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-neutral-900">
                Upload Your Resume
              </h1>
              <p className="text-neutral-500">
                We'll read it to auto-fill your work history on every
                application
              </p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-[13px] text-red-800">
                {error}
              </div>
            )}

            {!parsedResumeSummary ? (
              <ResumeDropZone
                onFile={handleResumeUpload}
                isLoading={resumeLoading}
              />
            ) : (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 space-y-4">
                <div className="flex items-start gap-3">
                  <span className="text-xl">✅</span>
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
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep(2)}
                className="flex-1 text-indigo-600 font-medium py-3 rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep(4)}
                disabled={!parsedResumeSummary}
                className="flex-1 bg-indigo-600 text-white font-medium py-3 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Looks Good →
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Profile */}
        {step === 4 && (
          <div className="space-y-8 animate-fade-in">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-neutral-900">
                Complete Your Profile
              </h1>
              <p className="text-neutral-500">
                This fills in your contact details on every application
                automatically
              </p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-[13px] text-red-800">
                {error}
              </div>
            )}

            <div className="space-y-5 bg-neutral-50 border border-neutral-200 rounded-xl p-6">
              {/* Row 1 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="First name*"
                  value={formData.firstName}
                  onChange={(e) =>
                    setFormData({ ...formData, firstName: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
                <input
                  type="text"
                  placeholder="Last name*"
                  value={formData.lastName}
                  onChange={(e) =>
                    setFormData({ ...formData, lastName: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
              </div>

              {/* Row 2 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  type="email"
                  placeholder="Email*"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
                <input
                  type="tel"
                  placeholder="Phone*"
                  value={formData.phone}
                  onChange={(e) =>
                    setFormData({ ...formData, phone: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
              </div>

              {/* Row 3 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="City"
                  value={formData.city}
                  onChange={(e) =>
                    setFormData({ ...formData, city: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
                <input
                  type="text"
                  placeholder="Province / State"
                  value={formData.province}
                  onChange={(e) =>
                    setFormData({ ...formData, province: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
              </div>

              {/* Row 4 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="LinkedIn URL"
                  value={formData.linkedin}
                  onChange={(e) =>
                    setFormData({ ...formData, linkedin: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
                <input
                  type="text"
                  placeholder="GitHub URL"
                  value={formData.github}
                  onChange={(e) =>
                    setFormData({ ...formData, github: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
              </div>

              {/* Row 5 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="Portfolio / Website"
                  value={formData.portfolio}
                  onChange={(e) =>
                    setFormData({ ...formData, portfolio: e.target.value })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
                <input
                  type="text"
                  placeholder="Current job title"
                  value={formData.currentCompany}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      currentCompany: e.target.value,
                    })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
              </div>

              {/* Row 6 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <select
                  value={formData.requireSponsorship}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      requireSponsorship: e.target.value,
                    })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                >
                  <option value="no">Canadian Citizen</option>
                  <option value="no">Permanent Resident</option>
                  <option value="no">Open Work Permit</option>
                  <option value="yes">Require Sponsorship</option>
                </select>
                <input
                  type="text"
                  placeholder="Salary expectation (optional)"
                  value={formData.salaryExpectation}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      salaryExpectation: e.target.value,
                    })
                  }
                  className="px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                />
              </div>

              {/* Row 7 */}
              <div>
                <select
                  value={formData.pronouns}
                  onChange={(e) =>
                    setFormData({ ...formData, pronouns: e.target.value })
                  }
                  className="w-full px-4 py-3 border border-neutral-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                >
                  <option value="">Pronouns (optional)</option>
                  <option value="">None</option>
                  <option value="He/Him">He/Him</option>
                  <option value="She/Her">She/Her</option>
                  <option value="They/Them">They/Them</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <p className="text-[11px] text-neutral-500">
                * = Required fields
              </p>
            </div>

            <div className="flex gap-3">
              {!isEditMode && (
                <button
                  onClick={() => setStep(3)}
                  className="flex-1 text-indigo-600 font-medium py-3 rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors"
                >
                  ← Back
                </button>
              )}
              <button
                onClick={handleSaveProfile}
                disabled={isLoading}
                className="flex-1 bg-indigo-600 text-white font-medium py-3 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? "Saving..." : "Save & Continue →"}
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
      if (file.type === "application/pdf") {
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
        accept=".pdf"
        onChange={handleFileInput}
        className="hidden"
      />

      {isLoading ? (
        <div className="space-y-2">
          <div className="w-12 h-12 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-[13px] text-neutral-600 font-medium">
            Reading your resume...
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] font-medium text-neutral-900">
            Drop your PDF here, or click to browse
          </p>
          <p className="text-[12px] text-neutral-500">PDF only, 10MB max</p>
        </div>
      )}
    </div>
  );
}
