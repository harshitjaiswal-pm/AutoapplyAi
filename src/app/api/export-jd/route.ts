import { NextRequest, NextResponse } from "next/server";

/**
 * API ROUTE: POST /api/export-jd
 *
 * Generates a downloadable PDF of a job description.
 * Uses jsPDF to create a clean, readable document.
 */

export async function POST(request: NextRequest) {
  try {
    const { jobTitle, company, location, jobDescription } = await request.json();

    if (!jobDescription) {
      return NextResponse.json(
        { error: "No job description provided." },
        { status: 400 }
      );
    }

    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "letter" });

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 50;
    const contentWidth = pageWidth - 2 * margin;
    let y = 50;

    const checkPage = (needed: number) => {
      if (y + needed > doc.internal.pageSize.getHeight() - 50) {
        doc.addPage();
        y = 50;
      }
    };

    // Title
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(27, 42, 74);
    const titleLines = doc.splitTextToSize(jobTitle || "Job Description", contentWidth);
    for (const line of titleLines) {
      checkPage(20);
      doc.text(line, margin, y);
      y += 20;
    }
    y += 4;

    // Company & Location
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(100, 100, 100);
    const subtitle = [company, location].filter(Boolean).join(" — ");
    if (subtitle) {
      doc.text(subtitle, margin, y);
      y += 16;
    }

    // Divider
    y += 4;
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;

    // Job description body
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(50, 50, 50);

    const paragraphs = jobDescription.split("\n");
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) {
        y += 8;
        continue;
      }

      const lines = doc.splitTextToSize(trimmed, contentWidth);
      for (const line of lines) {
        checkPage(14);
        doc.text(line, margin, y);
        y += 13;
      }
      y += 4;
    }

    const pdfBuffer = new Uint8Array(doc.output("arraybuffer"));

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=${encodeURIComponent(company || "job")}_JD.pdf`,
      },
    });
  } catch (error: unknown) {
    console.error("JD export error:", error);
    return NextResponse.json(
      { error: "Failed to export job description." },
      { status: 500 }
    );
  }
}
