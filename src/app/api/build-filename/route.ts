import { NextRequest, NextResponse } from "next/server";
import { buildResumeFilename } from "@/lib/buildFilename";

/**
 * API ROUTE: POST /api/build-filename
 * API ROUTE: GET  /api/build-filename?applicantName=...&company=...&role=...
 *
 * Returns the canonical tailored-resume filename (without extension) that
 * TailorEngine uses on the client. Exposed so external tooling (e.g. the
 * linkedin-apply Cowork skill that generates .docx locally) can produce
 * files with identical naming, keeping outputs consistent across surfaces.
 *
 * Body / query: { applicantName, company, role }
 * Returns:      { filename: "KS_Veeva_SBA" }
 *
 * CORS-enabled so the extension / skill / other tools can call it from
 * any origin without a proxy.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const filename = buildResumeFilename({
    applicantName: searchParams.get("applicantName") || undefined,
    company: searchParams.get("company") || undefined,
    role: searchParams.get("role") || undefined,
  });
  return NextResponse.json({ filename }, { headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  try {
    const { applicantName, company, role } = await request.json();
    const filename = buildResumeFilename({ applicantName, company, role });
    return NextResponse.json({ filename }, { headers: CORS_HEADERS });
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS }
    );
  }
}
