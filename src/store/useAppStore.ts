import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * TYPES — These define the shape of our data.
 */

export interface ParsedResume {
  contactInfo: {
    name: string;
    email: string;
    phone: string;
    location: string;
    linkedin?: string;
    portfolio?: string;
    authorization?: string;
  };
  summary: string;
  skills: {
    technical: string[];
    soft: string[];
    tools: string[];
  };
  experience: {
    company: string;
    role: string;
    location?: string;
    startDate: string;
    endDate: string;
    bullets: string[];
  }[];
  education: {
    school: string;
    degree: string;
    year: string;
    gpa?: string;
  }[];
  projects: {
    name: string;
    description: string;
    technologies: string[];
  }[];
  certifications: string[];
}

export interface ParsedJob {
  title: string;
  company: string;
  requiredSkills: string[];
  preferredSkills: string[];
  yearsExperience: string;
  responsibilities: string[];
  keywords: string[];
  cultureCues: string[];
}

export interface ResumeDefect {
  field: string;
  sourceValue: string;
  tailoredValue: string;
  severity: "error" | "warning";
  message: string;
}

export interface TailoredResult {
  originalMatchScore?: number;
  matchScore: number;
  matchBreakdown?: {
    requiredSkills: { score: number; max: number; detail: string };
    experienceLevel: { score: number; max: number; detail: string };
    industryMatch: { score: number; max: number; detail: string };
    preferredSkills: { score: number; max: number; detail: string };
    education: { score: number; max: number; detail: string };
    redFlags: { score: number; detail: string };
  };
  matchReasoning: string | {
    strengths: string[];
    gaps: string[];
    optimization: string;
  };
  tailoredResume: ParsedResume;
  coverLetter: string;
  changes: { category: string; text: string }[];
  // Guardrail validation results
  validation?: {
    sourceYears: number;
    tailoredYears: number;
    warnings: ResumeDefect[];
    hasDefects: boolean;
  };
}

// Legacy single-application tracking
export interface Application {
  id: string;
  jobTitle: string;
  company: string;
  jobUrl?: string;
  status: "matched" | "approved" | "applied" | "responded" | "interviewing" | "rejected" | "offer";
  appliedAt: string;
  resumeVersion: string;
  matchScore: number;
  defects?: ResumeDefect[];         // Guardrail warnings attached at tailor time
  sourceYears?: number;             // Years in original resume
  tailoredYears?: number;           // Years in tailored resume
}

/**
 * PIPELINE TYPES — For the agentic auto-apply system.
 * A PipelineJob represents a single job in the daily apply queue.
 */

export type PipelineStatus =
  | "queued"        // Job added, waiting to be processed
  | "analyzing"     // Parsing the JD
  | "tailoring"     // Tailoring resume for this job
  | "ready"         // Resume tailored, ready for review/apply
  | "applying"      // Auto-apply in progress
  | "applied"       // Successfully applied
  | "skipped"       // User skipped this job
  | "failed";       // Something went wrong

export interface PipelineJob {
  id: string;
  // Job info
  jobTitle: string;
  company: string;
  location: string;
  jobUrl: string;
  jobDescription: string;
  source: "linkedin" | "indeed" | "manual" | "other";
  easyApply: boolean; // LinkedIn Easy Apply available?

  // Processing state
  status: PipelineStatus;
  error?: string;

  // AI outputs (populated as pipeline progresses)
  parsedJob?: ParsedJob;
  tailoredResult?: TailoredResult;

  // Tracking
  addedAt: string;
  processedAt?: string;
  appliedAt?: string;

  // Scoring
  originalScore?: number;
  tailoredScore?: number;
}

export interface BatchRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  totalJobs: number;
  processed: number;
  succeeded: number;
  failed: number;
  isRunning: boolean;
}

/**
 * THE STORE — Zustand with localStorage persistence for pipeline data.
 */

interface UserProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  province: string;
  address: string;
  postalCode: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentCompany: string;
  pronouns: string;
  requireSponsorship: string;
  salaryExpectation: string;
}

interface ParsedResumeSummary {
  name: string;
  jobCount: number;
  skillCount: number;
}

interface AppState {
  // === Original single-resume flow ===
  rawResumeText: string;
  parsedResume: ParsedResume | null;
  parsedJob: ParsedJob | null;
  tailoredResult: TailoredResult | null;
  applications: Application[];
  isParsingResume: boolean;
  isAnalyzingJob: boolean;
  isTailoring: boolean;

  // Actions for single-resume flow
  setRawResumeText: (text: string) => void;
  setParsedResume: (resume: ParsedResume) => void;
  setParsedJob: (job: ParsedJob) => void;
  setTailoredResult: (result: TailoredResult | null) => void;
  addApplication: (app: Application) => void;
  updateApplicationStatus: (id: string, status: Application["status"]) => void;
  setIsParsingResume: (val: boolean) => void;
  setIsAnalyzingJob: (val: boolean) => void;
  setIsTailoring: (val: boolean) => void;

  // === Pipeline (batch auto-apply) ===
  pipelineJobs: PipelineJob[];
  currentBatch: BatchRun | null;
  pipelineResumeText: string;       // The base resume for pipeline
  pipelineParsedResume: ParsedResume | null;

  // Pipeline actions
  setPipelineResumeText: (text: string) => void;
  setPipelineParsedResume: (resume: ParsedResume) => void;
  addPipelineJob: (job: PipelineJob) => void;
  addPipelineJobs: (jobs: PipelineJob[]) => void;
  updatePipelineJob: (id: string, updates: Partial<PipelineJob>) => void;
  removePipelineJob: (id: string) => void;
  clearPipelineJobs: () => void;
  setCurrentBatch: (batch: BatchRun | null) => void;
  updateCurrentBatch: (updates: Partial<BatchRun>) => void;

  // === Onboarding ===
  onboardingComplete: boolean;
  onboardingStep: number;
  userProfile: UserProfile | null;
  parsedResumeSummary: ParsedResumeSummary | null;

  // Onboarding actions
  setOnboardingComplete: (val: boolean) => void;
  setOnboardingStep: (val: number) => void;
  setUserProfile: (profile: UserProfile) => void;
  setParsedResumeSummary: (summary: ParsedResumeSummary | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      // === Original single-resume flow ===
      rawResumeText: "",
      parsedResume: null,
      parsedJob: null,
      tailoredResult: null,
      applications: [],
      isParsingResume: false,
      isAnalyzingJob: false,
      isTailoring: false,

      setRawResumeText: (text) => set({ rawResumeText: text }),
      setParsedResume: (resume) => set({ parsedResume: resume }),
      setParsedJob: (job) => set({ parsedJob: job }),
      setTailoredResult: (result) => set({ tailoredResult: result }),
      addApplication: (app) =>
        set((state) => ({ applications: [...state.applications, app] })),
      updateApplicationStatus: (id, status) =>
        set((state) => ({
          applications: state.applications.map((a) =>
            a.id === id ? { ...a, status } : a
          ),
        })),
      setIsParsingResume: (val) => set({ isParsingResume: val }),
      setIsAnalyzingJob: (val) => set({ isAnalyzingJob: val }),
      setIsTailoring: (val) => set({ isTailoring: val }),

      // === Pipeline ===
      pipelineJobs: [],
      currentBatch: null,
      pipelineResumeText: "",
      pipelineParsedResume: null,

      setPipelineResumeText: (text) => set({ pipelineResumeText: text }),
      setPipelineParsedResume: (resume) => set({ pipelineParsedResume: resume }),
      addPipelineJob: (job) =>
        set((state) => ({ pipelineJobs: [...state.pipelineJobs, job] })),
      addPipelineJobs: (jobs) =>
        set((state) => ({ pipelineJobs: [...state.pipelineJobs, ...jobs] })),
      updatePipelineJob: (id, updates) =>
        set((state) => ({
          pipelineJobs: state.pipelineJobs.map((j) =>
            j.id === id ? { ...j, ...updates } : j
          ),
        })),
      removePipelineJob: (id) =>
        set((state) => ({
          pipelineJobs: state.pipelineJobs.filter((j) => j.id !== id),
        })),
      clearPipelineJobs: () => set({ pipelineJobs: [], currentBatch: null }),
      setCurrentBatch: (batch) => set({ currentBatch: batch }),
      updateCurrentBatch: (updates) =>
        set((state) => ({
          currentBatch: state.currentBatch
            ? { ...state.currentBatch, ...updates }
            : null,
        })),

      // === Onboarding ===
      onboardingComplete: false,
      onboardingStep: 1,
      userProfile: null,
      parsedResumeSummary: null,

      setOnboardingComplete: (val) => set({ onboardingComplete: val }),
      setOnboardingStep: (val) => set({ onboardingStep: val }),
      setUserProfile: (profile) => set({ userProfile: profile }),
      setParsedResumeSummary: (summary) => set({ parsedResumeSummary: summary }),
    }),
    {
      name: "autoapply-pipeline",
      // Only persist pipeline data and applications (not transient single-flow state)
      partialize: (state) => ({
        pipelineJobs: state.pipelineJobs,
        applications: state.applications,
        pipelineResumeText: state.pipelineResumeText,
        pipelineParsedResume: state.pipelineParsedResume,
        userProfile: state.userProfile,
        parsedResumeSummary: state.parsedResumeSummary,
      }),
    }
  )
);
