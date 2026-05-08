import { redis, submissionKey, submissionIndexKey } from "./redis";

/**
 * Shape of one submission record. Written by autoapply-worker's
 * submissions.ts. Kept in sync there. The web app reads only — never
 * writes — so changes to the worker schema must keep this readable.
 */
export interface SubmissionScreenshot {
  step: string;
  pageHeader?: string;
  url: string;
  capturedAt: string;
}

export interface SubmissionStepLog {
  name: string;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  note?: string;
  error?: string;
}

/**
 * One question/answer pair the worker filled during a wizard step.
 * Captured even on partial/failed runs so the user can pick up the
 * application manually without retyping every answer.
 */
export interface SubmissionAnswer {
  question: string;
  answer: string;
  step: number;
  pageHeader?: string;
  kind?: string;
}

/**
 * Typed failure category. Mirrored from worker/submissions.ts — keep in
 * sync. Drives the FAILURE_GUIDANCE map below.
 */
export type FailureCategory =
  | "job_posting_dead"
  | "job_posting_no_apply"
  | "tailoring_failed"
  | "create_account_stuck"
  | "create_account_email_in_use"
  | "otp_timeout"
  | "otp_error"
  | "verify_email_stuck"
  | "wizard_stuck_step"
  | "wizard_validation_errors"
  | "submit_modal_stuck"
  | "submit_no_button"
  | "submit_server_error"
  | "submit_validation_errors"
  | "submit_no_confirmation"
  | "worker_exception";

/**
 * Category → short label + descriptive title + actionable guidance.
 *
 * - `shortLabel`: 3 words max. Used in tight surfaces (Submissions list).
 * - `title`: descriptive phrase. Used in the recovery panel where there's room.
 * - `guidance`: one or two sentences ending with a concrete action.
 */
export const FAILURE_GUIDANCE: Record<
  FailureCategory,
  { shortLabel: string; title: string; guidance: string }
> = {
  job_posting_dead: {
    shortLabel: "Listing dead",
    title: "Listing no longer live",
    guidance: "The Workday URL returned a 'page not found' state — the company has likely pulled or expired this posting. Search the company's careers site for the same role; if it's been republished, the URL will have a new ID.",
  },
  job_posting_no_apply: {
    shortLabel: "No apply button",
    title: "Apply button missing",
    guidance: "The job description page loaded but no Apply button was visible. The role may be past its closing date, or the company has switched to a different application channel. Check the posting manually.",
  },
  tailoring_failed: {
    shortLabel: "Tailoring failed",
    title: "Resume tailoring failed",
    guidance: "Claude couldn't tailor the resume for this JD — usually transient (Anthropic rate limit, JSON parse error, or the JD was too short to analyze). Retry the same URL; the second run almost always succeeds.",
  },
  create_account_stuck: {
    shortLabel: "Signup stuck",
    title: "Account creation got stuck",
    guidance: "The Workday signup form was submitted but the post-submit page wasn't a recognizable verify-email or sign-in screen. Open the tenant portal manually with the credentials below to see what state the account is in.",
  },
  create_account_email_in_use: {
    shortLabel: "Email in use",
    title: "Email already has an account at this tenant",
    guidance: "Workday rejected the signup because this email already has an account on this tenant. Sign in with the credentials below (rather than creating a new account) to continue the application.",
  },
  otp_timeout: {
    shortLabel: "OTP timeout",
    title: "Verification email never arrived",
    guidance: "The OTP email didn't show up within the 5-minute window. The account exists but is unverified — check the linked Gmail's spam folder and click the verification link manually, then sign in via the portal to continue.",
  },
  otp_error: {
    shortLabel: "Gmail error",
    title: "Gmail polling errored",
    guidance: "The Gmail API returned an error while polling for the OTP. Check Gmail OAuth status (the worker may need a token refresh). Account creation likely succeeded; just retry once the Gmail link is healthy.",
  },
  verify_email_stuck: {
    shortLabel: "Verify failed",
    title: "Verification link didn't authenticate",
    guidance: "The verification email arrived and we clicked the link, but the post-click page didn't transition us into the wizard. Sign in manually via the portal — the account is verified, just not signed in.",
  },
  wizard_stuck_step: {
    shortLabel: "Wizard stuck",
    title: "Save & Continue silently swallowed",
    guidance: "A wizard step accepted our answers but the Save & Continue button didn't advance the page (no error, no progress). Tenant-specific issue — sign in via the portal and resume from the step shown below.",
  },
  wizard_validation_errors: {
    shortLabel: "Validation errors",
    title: "Validation errors blocked advance",
    guidance: "The form rejected one or more of our answers and the agent couldn't recover within its retry budget. The exact errors are in the step log below — sign in via the portal, fix those fields manually, and resume.",
  },
  submit_modal_stuck: {
    shortLabel: "Submit modal stuck",
    title: "Submit confirmation modal stuck",
    guidance: "We clicked Submit but the confirmation dialog appeared with a button shape we couldn't identify. The application is one click away — sign in via the portal and click Submit yourself.",
  },
  submit_no_button: {
    shortLabel: "No submit button",
    title: "Submit button not clickable",
    guidance: "We reached the Review page but couldn't click any Submit button after 3 retries. Sign in via the portal — your filled answers are preserved on the Review screen, just hit Submit manually.",
  },
  submit_server_error: {
    shortLabel: "Server error",
    title: "Workday returned a server error post-Submit",
    guidance: "After we clicked Submit, Workday's 'Something went wrong' page appeared and didn't recover after a reload. Often transient — retry the same URL in 30 minutes; if it persists, submit manually via the portal.",
  },
  submit_validation_errors: {
    shortLabel: "Submit rejected",
    title: "Submit rejected by validation",
    guidance: "Workday rejected our submission with one or more validation errors after we clicked Submit. The errors are listed below — sign in via the portal, fix them on the Review page, and Submit manually.",
  },
  submit_no_confirmation: {
    shortLabel: "No confirmation",
    title: "Submit clicked but no confirmation",
    guidance: "We clicked Submit successfully but no confirmation page loaded within 30 seconds. The application MAY have actually gone through — sign in via the portal and check My Applications before resubmitting.",
  },
  worker_exception: {
    shortLabel: "Worker crashed",
    title: "Worker hit an unexpected error",
    guidance: "Something threw an exception inside the worker that wasn't classified. The error message below is the raw stack trace — share with the developer and retry the URL.",
  },
};

export interface SubmissionRecord {
  applicationId: string;
  userId: string;
  jobUrl: string;
  jobTitle: string;
  company: string;
  tenant?: string;
  status: "in_progress" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  /** Match score (0-100) for the *tailored* resume vs the JD. */
  matchScore?: number;
  /** Match score for the *original* resume — surfaces improvement from tailoring. */
  originalMatchScore?: number;
  /** Cover letter Claude generated for this JD. Plain text / markdown. */
  coverLetter?: string;
  /** List of changes Claude made to the resume (e.g. "Added cloud experience"). */
  tailoringChanges?: Array<{ category: string; text: string }>;
  /** Cents the LLM tailoring run cost. */
  tailoringCostCents?: number;
  /** Structured tailored resume — lets the page render it inline without
   *  downloading the .docx. Matches /api/tailor-resume's tailoredResume shape. */
  tailoredResumeJson?: Record<string, unknown>;
  resumeFilename?: string;
  resumeUrl?: string;
  /** Set when the worker's tailored .docx upload to Vercel Blob failed at
   *  apply time. The application itself may still have completed (Workday
   *  got the .docx via direct upload during the wizard) — only the
   *  dashboard's archival copy is missing. Surfaced loudly so the gap is
   *  visible and engineer-actionable instead of silently looking like
   *  "(not captured for this run)". */
  resumeUploadError?: string;
  screenshots: SubmissionScreenshot[];
  steps: SubmissionStepLog[];
  errorMessage?: string;
  /** True iff the wizard reached a confirmation page after clicking Submit.
   *  Distinct from `status: "completed"`, which the worker writes on any
   *  clean exit (including partial advances). The dashboard uses THIS — not
   *  status — to choose between green Submitted vs amber Partial badges. */
  applicationSubmitted?: boolean;
  /** Human-readable reason the wizard stopped (e.g. "step 3 did not advance",
   *  "submitted; confirmation reached"). Surfaced as the stop-reason callout. */
  stoppedReason?: string;
  /** Q&A pairs the worker filled across all wizard steps — used as a
   *  manual-recovery aid when the wizard didn't fully submit. */
  subjectiveAnswers?: SubmissionAnswer[];
  /** Typed failure category for non-submitted runs. Drives the recovery
   *  panel's category-specific guidance. */
  failureCategory?: FailureCategory;
  /** User-entered note. Free-form. Edited in-line on the Submissions
   *  list — useful for tagging "manually finished", "bad role, ignore",
   *  "need to follow up", etc. Persists across worker re-runs because
   *  it's user-set, not worker-set. */
  userRemark?: string;
  /** Live activity label updated by the worker between major checkpoints
   *  (e.g. "Creating account at td.wd3…", "Polling Gmail for OTP…",
   *  "Wizard step 2/4: My Information"). Powers the pulsing live-status
   *  badge on the application detail page while status === "in_progress".
   *  Auto-cleared when the worker calls recordSubmissionFinish. */
  currentActivity?: string;
  /** ISO timestamp of the last currentActivity update. UI uses this to
   *  detect stale activity (worker died mid-step) and render a stale
   *  marker after some threshold. */
  currentActivityAt?: string;
  /** Two-phase review gate. After tailoring, the worker writes
   *  reviewStatus="awaiting_review" and pauses. The user reviews the
   *  tailored resume on /applications/[id] and clicks one of:
   *    - "Approve & Submit" → reviewStatus="approved" → worker resumes,
   *       walks the wizard, clicks Submit. No re-tailoring (zero $).
   *    - "Reject" → reviewStatus="rejected" → worker exits without
   *       touching Workday. Status flips to "failed". Terminal state.
   *  Records without this field at all are pre-gate (legacy) and behave
   *  as one-shot — keeps the field opt-in until every writer fills it. */
  reviewStatus?: "awaiting_review" | "approved" | "rejected";
  /** ISO timestamp of the last reviewStatus transition. */
  reviewStatusAt?: string;
  source: "smoke" | "queue";
}

/**
 * Derived submission outcome — five buckets. For new records "awaiting_review"
 * comes from reviewStatus directly (pause point between tailor and submit);
 * the others come from status + applicationSubmitted; legacy records (no
 * applicationSubmitted field) fall back to a confirmation-screenshot
 * heuristic so the dashboard doesn't lie about old runs.
 */
export type SubmissionOutcome =
  | "running"
  | "awaiting_review"
  | "submitted"
  | "already_applied"
  | "partial"
  | "failed";

export function deriveOutcome(s: SubmissionRecord): SubmissionOutcome {
  // Review-gate state takes precedence over status — the worker keeps
  // status="in_progress" while paused, but the dashboard needs a distinct
  // visual so the user knows action is required.
  if (s.reviewStatus === "awaiting_review") return "awaiting_review";
  // "approved" is transitional — worker is actively running phase 2 — and
  // "rejected" terminal (worker has set status=failed alongside it). Both
  // fall through to the regular status-based logic.
  if (s.status === "in_progress") return "running";
  if (s.status === "failed") return "failed";
  // status === "completed" — but is the application actually submitted?
  if (s.applicationSubmitted === true) {
    // Distinguish "submitted this run" from "already submitted in a prior run"
    if (s.stoppedReason?.toLowerCase().includes("already applied")) return "already_applied";
    return "submitted";
  }
  if (s.applicationSubmitted === false) return "partial";
  // Legacy records: infer from screenshots. The worker only takes a
  // step="confirmation" shot when looksLikeConfirmation matched after
  // clicking Submit, so its presence is a reliable proxy.
  const hasConfirmation = (s.screenshots ?? []).some((shot) => shot.step === "confirmation");
  return hasConfirmation ? "submitted" : "partial";
}

/**
 * List submissions for one user, newest first.
 * Reads the index set then bulk-fetches each blob.
 */
export async function listSubmissions(email: string): Promise<SubmissionRecord[]> {
  const ids = (await redis.smembers(submissionIndexKey(email))) as string[];
  if (!ids || ids.length === 0) return [];

  const keys = ids.map((id) => submissionKey(email, id));
  // mget returns elements aligned with keys; missing keys come back as null.
  // Cast through unknown because @upstash/redis returns the auto-deserialized JSON.
  const blobs = (await redis.mget(...keys)) as (SubmissionRecord | null)[];

  const records = blobs.filter((b): b is SubmissionRecord => b !== null);
  records.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return records;
}

/**
 * Fetch one submission by id.
 */
export async function getSubmission(
  email: string,
  applicationId: string
): Promise<SubmissionRecord | null> {
  const data = await redis.get<SubmissionRecord>(submissionKey(email, applicationId));
  return data ?? null;
}
