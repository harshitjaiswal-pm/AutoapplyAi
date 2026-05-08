/**
 * GET /api/applications/[id]/resume
 *
 * Returns the tailored .docx for a submission, with a clean
 * Content-Disposition header so the browser saves the file with our
 * chosen filename ("{Company}_{Candidate_Name}_Resume.docx").
 *
 * Resolves the .docx via three fallbacks:
 *   1. submission.resumeUrl set → proxy from Vercel Blob (existing path —
 *      the worker uploaded the .docx during the run)
 *   2. submission.tailoredResumeJson set but no Blob URL → render the .docx
 *      on demand by piping the JSON through /api/export-resume. Covers runs
 *      where Blob isn't configured (worker .env missing BLOB_READ_WRITE_TOKEN)
 *      or older runs predating the upload code.
 *   3. Neither → 404 with a clear message saying nothing was captured.
 *
 * Why the proxy: Chrome ignores the `download="..."` attribute on
 * cross-origin links unless the response sets Content-Disposition. Vercel
 * Blob doesn't add that header on its own. Without this proxy, downloads
 * land with the URL filename ("tailored-{uuid}.docx") which then carries
 * through to ATS packets — bad UX for recruiters.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSubmission } from "@/lib/submissions";

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

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const submission = await getSubmission(session.user.email, ctx.params.id);
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (submission.userId !== session.user.email) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const filename = buildResumeFilename(submission);

  // Path 1: Blob URL exists → proxy with our filename.
  if (submission.resumeUrl) {
    const upstream = await fetch(submission.resumeUrl);
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `Upstream Blob fetch failed: ${upstream.status}` }, { status: 502 });
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

  // Path 2: structured tailored JSON exists → render .docx on demand by
  // calling the same /api/export-resume the rest of the app uses. Means the
  // download button works on submissions where the worker's local .env
  // didn't have BLOB_READ_WRITE_TOKEN (the .docx was generated and saved to
  // the candidate's local Downloads folder during the run, but never made
  // it into the cloud Blob store).
  if (submission.tailoredResumeJson) {
    const exportUrl = new URL("/api/export-resume", _req.nextUrl.origin).toString();
    const exportRes = await fetch(exportUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume: submission.tailoredResumeJson,
        format: "docx",
      }),
    });
    if (!exportRes.ok || !exportRes.body) {
      const body = await exportRes.text().catch(() => "");
      return NextResponse.json(
        { error: `On-demand .docx export failed: ${exportRes.status} ${body.slice(0, 200)}` },
        { status: 502 }
      );
    }
    return new NextResponse(exportRes.body, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, max-age=0",
      },
    });
  }

  // Path 3: nothing to render.
  return NextResponse.json(
    {
      error:
        "No resume captured for this submission. The worker either ran before per-JD tailoring was wired in, or it failed before reaching the tailoring step. Re-run from the Console to generate one.",
    },
    { status: 404 }
  );
}
