/**
 * BATCH PROCESSOR — Processes multiple jobs concurrently with rate limiting.
 *
 * This runs CLIENT-SIDE and fires parallel requests to our existing API routes.
 * We limit concurrency to avoid rate-limiting from Claude API.
 *
 * Flow per job:
 *   1. Analyze JD → /api/analyze-job
 *   2. Tailor resume → /api/tailor-resume
 *   3. Update store with results
 */

import { PipelineJob, ParsedResume, useAppStore } from "@/store/useAppStore";

const MAX_CONCURRENT = 3; // Process 3 jobs at a time (safe for Haiku rate limits)

interface BatchCallbacks {
  onJobStart: (jobId: string) => void;
  onJobAnalyzed: (jobId: string) => void;
  onJobComplete: (jobId: string, score: number, tailoredScore: number) => void;
  onJobFailed: (jobId: string, error: string) => void;
  onBatchProgress: (processed: number, total: number) => void;
  onBatchComplete: (succeeded: number, failed: number) => void;
}

/**
 * Process a single job through the analyze → tailor pipeline.
 */
async function processJob(
  job: PipelineJob,
  parsedResume: ParsedResume,
  mode: "fast" | "pro",
  callbacks: BatchCallbacks
): Promise<boolean> {
  const { updatePipelineJob } = useAppStore.getState();

  try {
    // Step 1: Analyze the JD
    callbacks.onJobStart(job.id);
    updatePipelineJob(job.id, { status: "analyzing" });

    const analyzeRes = await fetch("/api/analyze-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription: job.jobDescription }),
    });

    if (!analyzeRes.ok) {
      throw new Error(`Analyze failed: ${analyzeRes.statusText}`);
    }

    const { parsedJob } = await analyzeRes.json();
    updatePipelineJob(job.id, { parsedJob, status: "tailoring" });
    callbacks.onJobAnalyzed(job.id);

    // Step 2: Tailor the resume
    const tailorRes = await fetch("/api/tailor-resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parsedResume,
        parsedJob,
        jobDescription: job.jobDescription,
        mode,
      }),
    });

    if (!tailorRes.ok) {
      throw new Error(`Tailor failed: ${tailorRes.statusText}`);
    }

    const { tailoredResult } = await tailorRes.json();

    updatePipelineJob(job.id, {
      status: "ready",
      tailoredResult,
      parsedJob,
      originalScore: tailoredResult.originalMatchScore ?? tailoredResult.matchScore,
      tailoredScore: tailoredResult.matchScore,
      processedAt: new Date().toISOString(),
    });

    callbacks.onJobComplete(
      job.id,
      tailoredResult.originalMatchScore ?? 0,
      tailoredResult.matchScore
    );
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    updatePipelineJob(job.id, {
      status: "failed",
      error: errorMessage,
    });
    callbacks.onJobFailed(job.id, errorMessage);
    return false;
  }
}

/**
 * Run the batch processor on all queued jobs.
 * Uses a semaphore pattern to limit concurrency.
 */
export async function runBatch(
  jobs: PipelineJob[],
  parsedResume: ParsedResume,
  mode: "fast" | "pro",
  callbacks: BatchCallbacks
): Promise<{ succeeded: number; failed: number }> {
  const queuedJobs = jobs.filter((j) => j.status === "queued");
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  // Semaphore: process MAX_CONCURRENT at a time
  const queue = [...queuedJobs];
  const running: Promise<void>[] = [];

  const processNext = async (): Promise<void> => {
    const job = queue.shift();
    if (!job) return;

    const success = await processJob(job, parsedResume, mode, callbacks);
    if (success) succeeded++;
    else failed++;
    processed++;
    callbacks.onBatchProgress(processed, queuedJobs.length);

    // Process next job in queue
    await processNext();
  };

  // Start MAX_CONCURRENT workers
  for (let i = 0; i < Math.min(MAX_CONCURRENT, queuedJobs.length); i++) {
    running.push(processNext());
  }

  await Promise.all(running);
  callbacks.onBatchComplete(succeeded, failed);

  return { succeeded, failed };
}

/**
 * Parse a block of text containing multiple job descriptions.
 * Expects jobs separated by "---" or "===".
 */
export function parseMultipleJDs(text: string): { title: string; company: string; description: string }[] {
  const blocks = text
    .split(/\n(?:---+|===+)\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 50); // Filter out tiny fragments

  return blocks.map((block, i) => {
    // Try to extract title and company from first few lines
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    let title = `Job ${i + 1}`;
    let company = "Unknown";

    // Heuristic: first line is often the title
    if (lines[0] && lines[0].length < 100) {
      title = lines[0];
    }
    // Second line often has company
    if (lines[1] && lines[1].length < 80) {
      company = lines[1].replace(/^at\s+/i, "").replace(/^-\s*/, "");
    }

    return { title, company, description: block };
  });
}

/**
 * Generate a unique ID for pipeline jobs.
 */
export function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
