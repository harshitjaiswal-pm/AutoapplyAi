import { NextRequest, NextResponse } from "next/server";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  TabStopType,
  TabStopPosition,
  LevelFormat,
  BorderStyle,
} from "docx";

/**
 * API ROUTE: POST /api/export-resume
 *
 * Generates a downloadable resume file in PDF or DOCX format.
 *
 * WHY SERVER-SIDE EXPORT?
 * The `docx` library works best in Node.js. While jsPDF can run in the browser,
 * generating the DOCX on the server keeps things consistent and gives us
 * more control over formatting.
 *
 * The frontend sends the structured resume data + desired format,
 * and this route returns the file as a binary download.
 */

export async function POST(request: NextRequest) {
  try {
    const { resume, format } = await request.json();

    if (!resume) {
      return NextResponse.json(
        { error: "No resume data provided." },
        { status: 400 }
      );
    }

    if (format === "docx") {
      return generateDocx(resume);
    } else {
      // Default to PDF
      return generatePdf(resume);
    }
  } catch (error: unknown) {
    console.error("Export error:", error);
    return NextResponse.json(
      { error: "Failed to export resume." },
      { status: 500 }
    );
  }
}

/**
 * Generate a DOCX resume using the docx library.
 * This creates a clean, professional, ATS-friendly resume.
 */
async function generateDocx(resume: any) {
  const NAVY = "1B2A4A";
  const GRAY = "555555";

  // Build experience paragraphs
  const experienceChildren: Paragraph[] = [];
  for (const exp of resume.experience || []) {
    // Line 1: Role (left) + Location (right)
    experienceChildren.push(
      new Paragraph({
        spacing: { before: 160, after: 40 },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun({ text: exp.role, bold: true, font: "Arial", size: 22, color: NAVY }),
          ...(exp.location
            ? [new TextRun({ text: `\t${exp.location}`, font: "Arial", size: 20, color: GRAY })]
            : []),
        ],
      })
    );
    // Line 2: Company | Dates (italic)
    experienceChildren.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({
            text: `${exp.company} | ${exp.startDate} – ${exp.endDate}`,
            italics: true,
            font: "Arial",
            size: 20,
            color: GRAY,
          }),
        ],
      })
    );
    // Bullets
    for (const bullet of exp.bullets || []) {
      experienceChildren.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          spacing: { after: 40 },
          children: [new TextRun({ text: bullet, font: "Arial", size: 20 })],
        })
      );
    }
  }

  // Build education paragraphs
  const educationChildren: Paragraph[] = [];
  for (const edu of resume.education || []) {
    educationChildren.push(
      new Paragraph({
        spacing: { before: 80, after: 40 },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun({ text: edu.degree, bold: true, font: "Arial", size: 20 }),
          new TextRun({ text: `\t${edu.year}`, font: "Arial", size: 20, color: GRAY }),
        ],
      })
    );
    educationChildren.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: edu.school, italics: true, font: "Arial", size: 20, color: GRAY })],
      })
    );
  }

  // Build projects paragraphs
  const projectChildren: Paragraph[] = [];
  for (const proj of resume.projects || []) {
    projectChildren.push(
      new Paragraph({
        spacing: { before: 80, after: 40 },
        children: [
          new TextRun({ text: proj.name, bold: true, font: "Arial", size: 20 }),
          new TextRun({ text: ` — ${proj.description}`, font: "Arial", size: 20 }),
        ],
      })
    );
    if (proj.technologies?.length) {
      projectChildren.push(
        new Paragraph({
          spacing: { after: 40 },
          children: [
            new TextRun({ text: "Technologies: ", bold: true, font: "Arial", size: 18, color: GRAY }),
            new TextRun({ text: proj.technologies.join(", "), font: "Arial", size: 18, color: GRAY }),
          ],
        })
      );
    }
  }

  function sectionHeading(text: string) {
    return new Paragraph({
      spacing: { before: 240, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: NAVY, space: 4 } },
      children: [
        new TextRun({
          text: text.toUpperCase(),
          bold: true,
          font: "Arial",
          size: 22,
          color: NAVY,
        }),
      ],
    });
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 180 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children: [
          // Name
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [
              new TextRun({
                text: resume.contactInfo?.name || "Your Name",
                bold: true,
                font: "Arial",
                size: 32,
                color: NAVY,
              }),
            ],
          }),
          // Contact line
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [
              new TextRun({
                text: [
                  resume.contactInfo?.email,
                  resume.contactInfo?.phone,
                  resume.contactInfo?.location,
                ]
                  .filter(Boolean)
                  .join("  |  "),
                font: "Arial",
                size: 20,
                color: GRAY,
              }),
            ],
          }),
          // LinkedIn / portfolio
          ...(resume.contactInfo?.linkedin || resume.contactInfo?.portfolio
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing: { after: 40 },
                  children: [
                    new TextRun({
                      text: [resume.contactInfo.linkedin, resume.contactInfo.portfolio]
                        .filter(Boolean)
                        .join("  |  "),
                      font: "Arial",
                      size: 18,
                      color: GRAY,
                    }),
                  ],
                }),
              ]
            : []),
          // Work authorization (e.g., "Canadian Permanent Resident")
          ...(resume.contactInfo?.authorization
            ? [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing: { after: 120 },
                  children: [
                    new TextRun({
                      text: resume.contactInfo.authorization,
                      bold: true,
                      font: "Arial",
                      size: 20,
                      color: NAVY,
                    }),
                  ],
                }),
              ]
            : []),

          // Summary
          ...(resume.summary
            ? [
                sectionHeading("Professional Summary"),
                new Paragraph({
                  spacing: { after: 80 },
                  children: [new TextRun({ text: resume.summary, font: "Arial", size: 20 })],
                }),
              ]
            : []),

          // Skills
          sectionHeading("Skills"),
          ...(resume.skills?.technical?.length
            ? [
                new Paragraph({
                  spacing: { after: 40 },
                  children: [
                    new TextRun({ text: "Technical: ", bold: true, font: "Arial", size: 20 }),
                    new TextRun({ text: resume.skills.technical.join(", "), font: "Arial", size: 20 }),
                  ],
                }),
              ]
            : []),
          ...(resume.skills?.tools?.length
            ? [
                new Paragraph({
                  spacing: { after: 40 },
                  children: [
                    new TextRun({ text: "Tools: ", bold: true, font: "Arial", size: 20 }),
                    new TextRun({ text: resume.skills.tools.join(", "), font: "Arial", size: 20 }),
                  ],
                }),
              ]
            : []),
          ...(resume.skills?.soft?.length
            ? [
                new Paragraph({
                  spacing: { after: 40 },
                  children: [
                    new TextRun({ text: "Soft Skills: ", bold: true, font: "Arial", size: 20 }),
                    new TextRun({ text: resume.skills.soft.join(", "), font: "Arial", size: 20 }),
                  ],
                }),
              ]
            : []),

          // Experience
          ...(experienceChildren.length
            ? [sectionHeading("Experience"), ...experienceChildren]
            : []),

          // Education
          ...(educationChildren.length
            ? [sectionHeading("Education"), ...educationChildren]
            : []),

          // Projects
          ...(projectChildren.length
            ? [sectionHeading("Projects"), ...projectChildren]
            : []),

          // Certifications
          ...(resume.certifications?.length
            ? [
                sectionHeading("Certifications"),
                new Paragraph({
                  spacing: { after: 40 },
                  children: [
                    new TextRun({
                      text: resume.certifications.join("  |  "),
                      font: "Arial",
                      size: 20,
                    }),
                  ],
                }),
              ]
            : []),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": "attachment; filename=tailored_resume.docx",
    },
  });
}

/**
 * Generate a PDF resume using jsPDF.
 * Clean, single-column, ATS-friendly format.
 */
async function generatePdf(resume: any) {
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

  // Name
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(27, 42, 74); // Navy
  const name = resume.contactInfo?.name || "Your Name";
  doc.text(name, pageWidth / 2, y, { align: "center" });
  y += 22;

  // Contact
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  const contact = [resume.contactInfo?.email, resume.contactInfo?.phone, resume.contactInfo?.location]
    .filter(Boolean)
    .join("  |  ");
  doc.text(contact, pageWidth / 2, y, { align: "center" });
  y += 14;

  if (resume.contactInfo?.linkedin || resume.contactInfo?.portfolio) {
    const links = [resume.contactInfo.linkedin, resume.contactInfo.portfolio].filter(Boolean).join("  |  ");
    doc.text(links, pageWidth / 2, y, { align: "center" });
    y += 14;
  }

  if (resume.contactInfo?.authorization) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(27, 42, 74);
    doc.text(resume.contactInfo.authorization, pageWidth / 2, y, { align: "center" });
    y += 14;
  }

  y += 8;

  // Helper: section heading
  const heading = (text: string) => {
    checkPage(30);
    doc.setDrawColor(27, 42, 74);
    doc.setLineWidth(1);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(27, 42, 74);
    doc.text(text.toUpperCase(), margin, y);
    y += 16;
  };

  // Helper: wrapped text
  const wrappedText = (text: string, fontSize: number, bold = false, indent = 0) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(fontSize);
    doc.setTextColor(50, 50, 50);
    const lines = doc.splitTextToSize(text, contentWidth - indent);
    for (const line of lines) {
      checkPage(14);
      doc.text(line, margin + indent, y);
      y += fontSize * 1.4;
    }
  };

  // Summary
  if (resume.summary) {
    heading("Professional Summary");
    wrappedText(resume.summary, 10);
    y += 4;
  }

  // Skills
  const allSkills = [
    ...(resume.skills?.technical || []),
    ...(resume.skills?.tools || []),
  ];
  if (allSkills.length) {
    heading("Skills");
    if (resume.skills?.technical?.length) {
      wrappedText(`Technical: ${resume.skills.technical.join(", ")}`, 10);
    }
    if (resume.skills?.tools?.length) {
      wrappedText(`Tools: ${resume.skills.tools.join(", ")}`, 10);
    }
    if (resume.skills?.soft?.length) {
      wrappedText(`Soft Skills: ${resume.skills.soft.join(", ")}`, 10);
    }
    y += 4;
  }

  // Experience
  if (resume.experience?.length) {
    heading("Experience");
    for (const exp of resume.experience) {
      if (!exp) continue;
      checkPage(40);
      const role = String(exp.role || "");
      const company = String(exp.company || "");
      const startDate = String(exp.startDate || "");
      const endDate = String(exp.endDate || "Present");
      const location = String(exp.location || "");
      if (!role && !company) continue;
      // Line 1: Role (left) + Location (right)
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(27, 42, 74);
      if (role) doc.text(role, margin, y);
      if (location) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        doc.text(location, pageWidth - margin, y, { align: "right" });
      }
      y += 14;
      // Line 2: Company | Dates
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      const dateLine = [company, startDate && endDate ? `${startDate} – ${endDate}` : ""].filter(Boolean).join(" | ");
      if (dateLine) doc.text(dateLine, margin, y);
      y += 12;
      // Bullets
      for (const bullet of exp.bullets || []) {
        checkPage(14);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(50, 50, 50);
        doc.text("\u2022", margin + 8, y);
        const bulletLines = doc.splitTextToSize(bullet, contentWidth - 24);
        for (const line of bulletLines) {
          doc.text(line, margin + 20, y);
          y += 12;
        }
      }
      y += 6;
    }
  }

  // Education
  if (resume.education?.length) {
    heading("Education");
    for (const edu of resume.education) {
      if (!edu) continue;
      checkPage(28);
      const degree = String(edu.degree || "");
      const year = String(edu.year || "");
      const school = String(edu.school || "");
      if (!degree && !school) continue;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(27, 42, 74);
      if (degree) doc.text(degree, margin, y);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      if (year) doc.text(year, pageWidth - margin, y, { align: "right" });
      y += 14;
      doc.setFont("helvetica", "italic");
      if (school) doc.text(school, margin, y);
      y += 14;
    }
  }

  // Projects
  if (resume.projects?.length) {
    heading("Projects");
    for (const proj of resume.projects) {
      if (!proj) continue;
      checkPage(28);
      const projName = String(proj.name || "");
      const projDesc = String(proj.description || "");
      if (!projName) continue;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(27, 42, 74);
      doc.text(projName, margin, y);
      y += 13;
      if (projDesc) wrappedText(projDesc, 9, false, 0);
      if (proj.technologies?.length) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text(`Tech: ${proj.technologies.filter(Boolean).join(", ")}`, margin, y);
        y += 12;
      }
      y += 4;
    }
  }

  const pdfBuffer = new Uint8Array(doc.output("arraybuffer"));

  return new NextResponse(pdfBuffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=tailored_resume.pdf",
    },
  });
}
