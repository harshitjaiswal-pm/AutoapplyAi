/**
 * GET /api/applications/[id]/resume
 *
 * Proxies the tailored .docx download from Vercel Blob with a clean
 * Content-Disposition header so the browser saves the file with our
 * chosen filename ("{Company}_{Candidate_Name}_Resume.docx") regardless
 * of cross-origin behavior.
 *
 * Why we need this proxy: Chrome ignores the `download="..."` attribute
 * on cross-origin links unless the response sets Content-Disposition.
 * Vercel Blob doesn't add that header on its own. Without this proxy,
 * downloads from the dashboard land in the user's Downloads folder with
 * the URL filename ("tailored-{uuid}.docx" for older backfilled records),
 * which then carries through if they manually upload it to a Workday
 * form — bad UX, recruiter sees garbage filename in the ATS packet.
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
  if (!submission.resumeUrl) {
    return NextResponse.json({ error: "No resume available for this submission" }, { status: 404 });
  }

  // Fetch the .docx from Blob and re-stream it with the correct filename
  // so the browser actually uses our naming. RFC 5987 form for the
  // filename so non-ASCII characters survive (just in case).
  const filename = buildResumeFilename(submission);
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
