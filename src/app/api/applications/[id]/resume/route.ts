/**
 * GET /api/applications/[id]/resume
 *
 * Two paths:
 *  1. Cached (preferred): submission.resumeUrl exists → proxy from Vercel
 *     Blob with a clean Content-Disposition header so the browser saves
 *     the file as "{Company}_{Candidate_Name}_Resume.docx".
 *  2. On-demand fallback: submission.resumeUrl missing (worker didn't
 *     upload to Blob — older code, missing token, or wizard died before
 *     tailoring) → tailor a fresh resume server-side using the user's
 *     parsedResume + the submission's jobTitle/company, then export to
 *     .docx and stream back. Slower (~30-60s), but guarantees every
 *     application has a downloadable tailored resume regardless of where
 *     the original worker run failed.
 *
 * Why both paths matter: the dashboard's drill-down ALWAYS shows a
 * Resume download button (don't make the user dig through %TEMP% on
 * whichever laptop the run happened on). When the worker captured a
 * resume → instant download. When it didn't → the user waits a bit
 * but gets the same recruiter-ready .docx.
 */
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSubmission } from "@/lib/submissions";
import { redis, userResumeKey, submissionKey } from "@/lib/redis";

function buildResumeFilename(s: { company?: string; tenant?: string; tailoredResumeJson?: Record<string, unknown> }): string {
  const safe = (str: string) => str.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const companyRaw = s.company || s.tenant?.split(".")[0] || "";
  const company = safe(companyRaw)
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("_");
  const contact = (s.tailoredResumeJson as { contactInfo?: { name?: string } } | undefined)?.contactInfo;
  const candidate = safe(contact?.name || "Resume");
  if (!company) return `${candidate}_Resume.docx`;
  return `${company}_${candidate}_Resume.docx`;
}

interface StoredResume {
  resumeText?: string;
  parsedResume?: Record<string, unknown>;
  parsedResumeSummary?: Record<string, unknown>;
  savedAt?: string;
}

/**
 * Generate a fresh tailored .docx on-demand by calling the existing
 * /api/tailor-resume + /api/export-resume routes in-process. Uses the
 * incoming request's origin so it works the same in prod and local dev.
 */
async function tailorOnDemand(
  origin: string,
  parsedResume: Record<string, unknown>,
  parsedJob: { title: string; company: string; description?: string },
  cookieHeader: string
): Promise<
  | {
      buffer: ArrayBuffer;
      tailoredResumeJson?: Record<string, unknown>;
      rawTailorOuter?: Record<string, unknown>;
    }
  | { error: string; status: number }
> {
  // 1. Tailor — Haiku for speed since this is on-demand from a UI click.
  const tailorRes = await fetch(`${origin}/api/tailor-resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ parsedResume, parsedJob, mode: "fast" }),
  });
  if (!tailorRes.ok) {
    const body = await tailorRes.text().catch(() => "");
    return { error: `Tailoring failed (HTTP ${tailorRes.status}): ${body.slice(0, 200)}`, status: 502 };
  }
  const tailorData = (await tailorRes.json()) as { tailoredResult?: Record<string, unknown> };
  // The route wraps under tailoredResume; unwrap to the flat shape that
  // /api/export-resume expects.
  const outer = tailorData.tailoredResult as Record<string, unknown> | undefined;
  const resumePayload =
    outer && typeof outer === "object" && "tailoredResume" in outer
      ? (outer.tailoredResume as Record<string, unknown>)
      : outer;
  if (!resumePayload || typeof resumePayload !== "object") {
    return { error: "Tailoring returned no resume payload", status: 502 };
  }

  // 2. Export to .docx
  const exportRes = await fetch(`${origin}/api/export-resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ resume: resumePayload, format: "docx" }),
  });
  if (!exportRes.ok) {
    const body = await exportRes.text().catch(() => "");
    return { error: `Export failed (HTTP ${exportRes.status}): ${body.slice(0, 200)}`, status: 502 };
  }
  const buffer = await exportRes.arrayBuffer();
  return { buffer, tailoredResumeJson: resumePayload, rawTailorOuter: outer };
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;

  const submission = await getSubmission(email, ctx.params.id);
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (submission.userId !== email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Path 1: cached Blob proxy ─────────────────────────────────────
  if (submission.resumeUrl) {
    const filename = buildResumeFilename(submission);
    const upstream = await fetch(submission.resumeUrl);
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `Upstream Blob fetch failed: ${upstream.status}` },
        { status: 502 }
      );
    }
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, max-age=0",
      },
    });
  }

  // ── Path 2: tailor on-demand for runs that didn't capture a Blob ──
  // Pull the user's parsedResume from Upstash. Without it we can't
  // tailor; tell the user to upload via /onboarding first.
  const stored = await redis.get<StoredResume>(userResumeKey(email));
  if (!stored?.parsedResume) {
    return NextResponse.json(
      {
        error:
          "No resume on file to tailor. Upload yours via /onboarding/resume first, then try again.",
      },
      { status: 412 }
    );
  }

  const parsedJob = {
    title: submission.jobTitle || "Untitled Role",
    company: submission.company || submission.tenant?.split(".")[0] || "",
    description:
      `Job title: ${submission.jobTitle || "Untitled"}\nCompany: ${submission.company || ""}\n` +
      `Source: ${submission.jobUrl || ""}\n\n` +
      `(Full job description not captured — tailoring is based on title, company, and the candidate's resume.)`,
  };

  const origin = req.nextUrl.origin;
  const cookieHeader = req.headers.get("cookie") ?? "";
  const result = await tailorOnDemand(origin, stored.parsedResume, parsedJob, cookieHeader);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // Build filename using the tailoredResumeJson we just generated so the
  // candidate name reflects what's actually inside the .docx.
  const filename = buildResumeFilename({
    company: submission.company,
    tenant: submission.tenant,
    tailoredResumeJson: result.tailoredResumeJson,
  });

  // ── Save the result back to Blob + Upstash so subsequent views are
  //    instant from cache and the dashboard's other panels (inline
  //    preview, cover letter, tailoring changes) populate too. The
  //    laptop the worker ran on is no longer relevant — once a resume
  //    has been generated for an application, it lives on the server
  //    and is downloadable forever from the dashboard.
  let resumeUrl: string | undefined;
  try {
    const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, "_");
    const blobKey = `submissions/${safeEmail}/${ctx.params.id}/${filename}`;
    const putResult = await put(blobKey, Buffer.from(result.buffer), {
      access: "public",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    resumeUrl = putResult.url;
  } catch (e) {
    // Blob save failed — still serve the .docx so the user gets their
    // download, but log so we know the cache isn't being populated.
    console.warn(
      "[resume] on-demand Blob save failed; serving without caching:",
      (e as Error).message
    );
  }

  // Patch the submission record with everything we just generated. Future
  // dashboard loads see the cached resume URL, the inline preview JSON,
  // and the cover letter / tailoring changes if we got them back from
  // the tailor route.
  try {
    const tailorOuter = result.rawTailorOuter;
    const patch: Record<string, unknown> = {
      ...submission,
      tailoredResumeJson: result.tailoredResumeJson,
      resumeFilename: filename,
    };
    if (resumeUrl) patch.resumeUrl = resumeUrl;
    if (tailorOuter) {
      if (typeof tailorOuter.matchScore === "number") patch.matchScore = tailorOuter.matchScore;
      if (typeof tailorOuter.originalMatchScore === "number")
        patch.originalMatchScore = tailorOuter.originalMatchScore;
      if (typeof tailorOuter.coverLetter === "string") patch.coverLetter = tailorOuter.coverLetter;
      if (Array.isArray(tailorOuter.changes)) patch.tailoringChanges = tailorOuter.changes;
    }
    await redis.set(submissionKey(email, ctx.params.id), patch, { ex: 60 * 60 * 24 * 90 });
  } catch (e) {
    console.warn("[resume] failed to patch submission record:", (e as Error).message);
  }

  return new NextResponse(result.buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, max-age=0",
      "X-Resume-Source": resumeUrl ? "on-demand-cached" : "on-demand",
    },
  });
}
