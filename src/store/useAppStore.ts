import { create } from "zustand";

/**
 * TYPES — These define the shape of our data.
 *
 * Think of types like a form template. They don't hold data themselves,
 * but they describe what data should look like.
 * TypeScript uses these to catch errors BEFORE your code runs.
 */

// What a parsed resume looks like (output from AI)
export interface ParsedResume {
  contactInfo: {
    name: string;
    email: string;
    phone: string;
    location: string;
    linkedin?: string;
    portfolio?: string;
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

// What a parsed job description looks like
export interface ParsedJob {
  title: string;
  company: string;
  requiredSkills: string[];
  preferredSkills: string[];
  yearsExperience: string;
  responsibilities: string[];
  keywords: string[];       // ATS-important keywords
  cultureCues: string[];    // What the company values
}

// A tailored resume result
export interface TailoredResult {
  matchScore: number;
  matchBreakdown?: {
    requiredSkills: { score: number; max: number; detail: string };
    experienceLevel: { score: number; max: number; detail: string };
    industryMatch: { score: number; max: number; detail: string };
    preferredSkills: { score: number; max: number; detail: string };
    education: { score: number; max: number; detail: string };
    redFlags: { score: number; detail: string };
  };
  matchReasoning: string;
  tailoredResume: ParsedResume;
  coverLetter: string;
  changes: string[];  // Human-readable list of what changed
}

// A tracked application
export interface Application {
  id: string;
  jobTitle: string;
  company: string;
  jobUrl?: string;
  status: "matched" | "approved" | "applied" | "responded" | "interviewing" | "rejected" | "offer";
  appliedAt: string;
  resumeVersion: string;  // Which tailored resume was used
  matchScore: number;
}

/**
 * THE STORE — Zustand state management.
 *
 * This is like a global variable that any component can read from and write to.
 * When the store updates, every component that uses it automatically re-renders.
 *
 * Why Zustand? React's built-in state (useState) only works within a single component.
 * When you navigate from the "upload resume" page to the "tailor" page,
 * you need the parsed resume data to travel with you. That's what the store does.
 */

interface AppState {
  // Data
  rawResumeText: string;
  parsedResume: ParsedResume | null;
  parsedJob: ParsedJob | null;
  tailoredResult: TailoredResult | null;
  applications: Application[];

  // Loading states (so we can show spinners)
  isParsingResume: boolean;
  isAnalyzingJob: boolean;
  isTailoring: boolean;

  // Actions (functions to update the data)
  setRawResumeText: (text: string) => void;
  setParsedResume: (resume: ParsedResume) => void;
  setParsedJob: (job: ParsedJob) => void;
  setTailoredResult: (result: TailoredResult) => void;
  addApplication: (app: Application) => void;
  updateApplicationStatus: (id: string, status: Application["status"]) => void;
  setIsParsingResume: (val: boolean) => void;
  setIsAnalyzingJob: (val: boolean) => void;
  setIsTailoring: (val: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Initial state — everything starts empty
  rawResumeText: "",
  parsedResume: null,
  parsedJob: null,
  tailoredResult: null,
  applications: [],
  isParsingResume: false,
  isAnalyzingJob: false,
  isTailoring: false,

  // Actions — each one updates a specific piece of state
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
}));
