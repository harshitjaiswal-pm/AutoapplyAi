/**
 * POST /api/blob-upload
 *
 * Server-side Vercel Blob upload proxy. Workers (Playwright agents
 * running on Harshit's / Kiran's laptops) POST tailored .docx files
 * and step screenshots here; this route uses the server-side
 * BLOB_READ_WRITE_TOKEN (auto-injected by Vercel) to write to the
 * Blob store and returns the public URL.
 *
 * Why this exists: previously the worker called @vercel/blob directly,
 * which required BLOB_READ_WRITE_TOKEN to be present on EVERY laptop
 * running the worker. That meant new laptops (Kiran's MacBook for
 * Cubic on 2026-05-06) silently skipped uploads and the dashboard
 * showed 'resume not captured' for those runs — defeats the whole
 * point of having centralized Blob storage. Routing uploads through
 * this endpoint moves the token requirement to the server, where it's
 * auto-injected once. Workers just need to be able to reach the web
 * app, which they already do for /api/tailor-resume.
 *
 * Validation: the request must reference an existing submission record
 * in Upstash for the supplied email — i.e. you can only upload a file
 * tagged to a real run, not arbitrarily pollute the bucket. This is
 * soft auth (anyone who knows an email + appId combo could overwrite
 * its blobs), acceptable for a personal job-application tool.
 *
 * Request: multipart/form-data
 *   file        — the binary
 *   kind        — "resume" | "screenshot"
 *   email       — submission owner email
 *   applicationId — submission's applicationId
 *   filename    — desired filename (becomes the last segment of the Blob key)
 *
 * Response: 200 { url }  or  4xx/5xx { error }
 */
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { redis, submissionKey } from "@/lib/redis";

// 10MB hard cap — way above any tailored .docx (typ. 10kb) or screenshot
// (typ. 200kb), but below Vercel's request body limit. Catches anyone
// trying to dump arbitrary files through this endpoint.
const MAX_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPE_BY_KIND: Record<string, string> = {
  resume: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  screenshot: "image/png",
};

export async function POST(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Server is not configured for Blob uploads (BLOB_READ_WRITE_TOKEN missing)." },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to parse multipart body: ${(e as Error).message}` },
      { status: 400 }
    );
  }

  const file = form.get("file");
  const kind = String(form.get("kind") ?? "");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const applicationId = String(form.get("applicationId") ?? "").trim();
  const filename = String(form.get("filename") ?? "").trim();

  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing or invalid 'file' field." }, { status: 400 });
  }
  if (kind !== "resume" && kind !== "screenshot") {
    return NextResponse.json({ error: "'kind' must be 'resume' or 'screenshot'." }, { status: 400 });
  }
  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: "Invalid 'email'." }, { status: 400 });
  }
  if (!applicationId) {
    return NextResponse.json({ error: "Missing 'applicationId'." }, { status: 400 });
  }
  if (!filename) {
    return NextResponse.json({ error: "Missing 'filename'." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large: ${file.size} bytes (max ${MAX_BYTES}).` },
      { status: 413 }
    );
  }

  // Soft-auth: reject if no submission record exists for this email + appId.
  // Prevents random uploads from polluting Blob with files that have no
  // dashboard home.
  const existing = await redis.get(submissionKey(email, applicationId));
  if (!existing) {
    return NextResponse.json(
      {
        error:
          "No submission record found for this email + applicationId. The worker must call recordSubmissionStart() before uploading files.",
      },
      { status: 404 }
    );
  }

  // Sanitize email for the Blob key path (same convention the worker
  // used for direct uploads: replace non-ASCII-alphanumeric with `_`).
  const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `submissions/${safeEmail}/${applicationId}/${filename}`;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await put(key, buffer, {
      access: "public",
      contentType: CONTENT_TYPE_BY_KIND[kind],
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return NextResponse.json({ url: result.url });
  } catch (e) {
    console.error("[blob-upload] put failed:", e);
    return NextResponse.json(
      { error: `Blob upload failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
