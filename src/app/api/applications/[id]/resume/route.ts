/**
 * GET /api/applications/[id]/resume
 *
 * Cached Blob proxy for the resume that was actually sent to the
 * employer at submission time. The dashboard is a historical record:
 * we stream back exactly what the worker uploaded, never anything
 * generated after the fact.
 *
 * If the submission has no resumeUrl, the worker didn't capture one
 * for this run — return 404 with the recovery instructions instead
 * of fabricating a fresh tailored resume here. Generating on-demand
 * would corrupt the dashboard's "what we applied with" contract.
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

  if (!submission.resumeUrl) {
    return NextResponse.json(
      {
        error:
          "The resume that was sent for this submission was not captured by the worker. " +
          "To recover it, run `npx tsx scripts/backfill_submission.ts <email> <appId>` from " +
          "the laptop where the original submission ran (the .docx is in that laptop's " +
          "%TEMP%/autoapply-tailored/ or os.tmpdir()/autoapply-tailored/).",
      },
      { status: 404 }
    );
  }

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
