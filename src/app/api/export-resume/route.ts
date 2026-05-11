import { NextRequest, NextResponse } from "next/server";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  TabStopType,
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

/**
 * Normalize the AI's skills output into a flat array of { category, items }.
 * Handles all known shapes the AI might return:
 *   A: { technical: ["skill1"], tools: ["tool1"] }
 *   B: { "Product & Strategy": ["skill1"], "Data & Analytics": ["skill2"] }
 *   C: { categories: [{ name: "...", skills: ["..."] }] }
 *   D: [{ name: "...", skills: ["..."] }]
 *   E: values are objects instead of strings (e.g. [{ name: "SQL" }])
 */
function normalizeSkills(
  skills: unknown
): Array<{ category: string; items: string[] }> {
  if (!skills || typeof skills !== "object") return [];

  const result: Array<{ category: string; items: string[] }> = [];

  function extractItems(arr: unknown[]): string[] {
    return arr
      .map((v) => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object") {
          const obj = v as Record<string, unknown>;
          return String(obj.name || obj.skill || obj.text || "");
        }
        return String(v);
      })
      .filter(Boolean);
  }

  function processCategory(cat: unknown) {
    if (!cat || typeof cat !== "object") return;
    const c = cat as Record<string, unknown>;
    const name = String(c.name || c.category || "Other");
    const items = Array.isArray(c.skills)
      ? c.skills
      : Array.isArray(c.items)
        ? c.items
        : [];
    const extracted = extractItems(items);
    if (extracted.length > 0) result.push({ category: name, items: extracted });
  }

  if (Array.isArray(skills)) {
    // Shape D: skills is directly an array of { name, skills }
    for (const cat of skills) processCategory(cat);
  } else {
    const obj = skills as Record<string, unknown>;
    if (Array.isArray(obj.categories)) {
      // Shape C: { categories: [...] }
      for (const cat of obj.categories) processCategory(cat);
    } else {
      // Shape A/B: { key: [...], ... }
      for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value) && value.length > 0) {
          const items = extractItems(value);
          const categoryName =
            key.charAt(0).toUpperCase() + key.slice(1);
          if (items.length > 0)
            result.push({ category: categoryName, items });
        }
      }
    }
  }

  return result;
}

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

  // Build experience paragraphs in the reference-resume format:
  //   Line 1 (bold navy): "{Company}  |  {Title}"
  //   Line 2 (italic gray): "{Location}  |  {Dates}"
  // No tab-aligned right-side date; everything reads left-to-right with pipe separators.
  const experienceChildren: Paragraph[] = [];
  for (const exp of resume.experience || []) {
    const titleField = exp.title || exp.role || "";
    // Line 1: Company | Title
    // Tighter `before` spacing to maximize page-1 density. keepNext to keep
    // the role header, location/dates line, and at least the first bullet
    // on the same page (prevents an awkward orphan header at page-bottom).
    experienceChildren.push(
      new Paragraph({
        spacing: { before: 100, after: 30 },
        keepNext: true,
        children: [
          new TextRun({
            text: titleField ? `${exp.company}  |  ${titleField}` : `${exp.company}`,
            bold: true,
            font: "Arial",
            size: 22,
            color: NAVY,
          }),
        ],
      })
    );
    // Line 2: Location | Dates (italic, gray)
    const dateStr = (() => {
      if (exp.startDate && exp.endDate) return `${exp.startDate} – ${exp.endDate}`;
      if (exp.startDate) return `${exp.startDate} – Present`;
      if (typeof exp.dates === "string" && exp.dates.trim()) return exp.dates.trim();
      return "";
    })();
    const locDateLine = [exp.location, dateStr].filter(Boolean).join("  |  ");
    if (locDateLine) {
      experienceChildren.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({
              text: locDateLine,
              italics: true,
              font: "Arial",
              size: 20,
              color: GRAY,
            }),
          ],
        })
      );
    }
    // Bullets
    for (const bullet of exp.bullets || []) {
      experienceChildren.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          spacing: { after: 40 },
          alignment: AlignmentType.JUSTIFIED,
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
        // Use explicit right margin position (page width 12240 - left/right margin 720 each = 10800)
        // rather than TabStopPosition.MAX which resolves to 9026 — too short for letter-size pages
        // and caused the location/year text to sit mid-line instead of the true right edge.
        tabStops: [{ type: TabStopType.RIGHT, position: 10800 }],
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

  // Projects section intentionally OMITTED. User decision 2026-05-11: the
  // tailored resume should focus on role-level experience, skills, and
  // certifications — a separate Projects section reads as filler when the
  // candidate already has 8+ years in relevant roles. Project-worthy work
  // is surfaced as bullets under the role where it happened (see RESUME_
  // TAILOR_SYSTEM rule 18). If older saved resumes still have a projects
  // array, we silently skip rendering it rather than breaking on bad data.
  const projectChildren: Paragraph[] = [];

  function sectionHeading(text: string) {
    return new Paragraph({
      spacing: { before: 140, after: 60 },
      alignment: AlignmentType.LEFT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: NAVY, space: 4 } },
      // keepNext: prevents the section header from stranding alone at the
      // bottom of a page (the case where Page 1 ended with "CERTIFICATIONS"
      // header and Page 2 had only the cert line). Forces the header to
      // stay with the next paragraph.
      keepNext: true,
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
                sectionHeading("Executive Summary"),
                new Paragraph({
                  spacing: { after: 80 },
                  alignment: AlignmentType.JUSTIFIED,
                  children: [new TextRun({ text: resume.summary, font: "Arial", size: 20 })],
                }),
              ]
            : []),

          // Core Strengths — flatten the categorized skills object into a
          // single pipe-separated line (matches reference resume formatting).
          // The LLM still outputs categorized skills; we just render them flat
          // so the visual emphasis stays on the strengths themselves rather
          // than the category labels (which often feel like AI scaffolding).
          ...((() => {
            const skillEntries = normalizeSkills(resume.skills);
            if (skillEntries.length === 0) return [];
            const allSkills = skillEntries
              .flatMap((entry) => entry.items)
              .map((s) => String(s).trim())
              .filter((s) => s.length > 0);
            // Dedupe (case-insensitive) while preserving first-appearance order.
            const seen = new Set<string>();
            const flat = allSkills.filter((s) => {
              const k = s.toLowerCase();
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            if (flat.length === 0) return [];
            return [
              sectionHeading("Core Strengths"),
              new Paragraph({
                spacing: { after: 40 },
                alignment: AlignmentType.JUSTIFIED,
                children: [
                  new TextRun({
                    text: flat.join("  |  "),
                    font: "Arial",
                    size: 20,
                  }),
                ],
              }),
            ];
          })()),

          // Experience
          ...(experienceChildren.length
            ? [sectionHeading("Professional Experience"), ...experienceChildren]
            : []),

          // Education
          ...(educationChildren.length
            ? [sectionHeading("Education"), ...educationChildren]
            : []),

          // Projects section omitted by design (2026-05-11). Keeping
          // the placeholder spread so the section ordering stays stable
          // and a future re-enable is a one-line change.
          ...(projectChildren.length
            ? [sectionHeading("Projects"), ...projectChildren]
            : []),

          // Certifications — pipe-separated single line to match reference.
          // [Fix 2026-04-14] Claude sometimes returns certs as objects like
          // {name: "AWS", issuer: "Amazon", year: 2023} instead of plain strings.
          // Array.join() on objects produces "[object Object]" in the exported
          // resume. Normalize every entry to a display string before joining.
          // keepLines so the cert content can't get split across pages, and
          // the section header has keepNext so it stays glued to this content
          // (the page-1.5 stranding fix).
          ...(resume.certifications?.length
            ? [
                sectionHeading("Certifications"),
                new Paragraph({
                  spacing: { after: 40 },
                  keepLines: true,
                  children: [
                    new TextRun({
                      text: (resume.certifications as unknown[])
                        .map((c) => {
                          if (!c) return "";
                          if (typeof c === "string") return c;
                          if (typeof c === "object") {
                            const obj = c as Record<string, unknown>;
                            const name =
                              obj.name || obj.title || obj.certification || obj.cert || "";
                            const issuer = obj.issuer || obj.organization || obj.org || "";
                            const year = obj.year || obj.date || obj.issued || "";
                            const parts = [name, issuer, year]
                              .map((p) => (p == null ? "" : String(p).trim()))
                              .filter(Boolean);
                            return parts.join(" — ");
                          }
                          return String(c);
                        })
                        .filter(Boolean)
                        .join("  |  "),
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
/**
 * Sanitize text for jsPDF — Helvetica only supports Latin-1 (ISO-8859-1).
 * Replace common special characters with ASCII equivalents.
 */
function sanitizeForPdf(text: string): string {
  if (!text) return "";
  return String(text)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // Smart single quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // Smart double quotes
    .replace(/\u2013/g, "-")                        // En dash
    .replace(/\u2014/g, "--")                       // Em dash
    .replace(/\u2022/g, "*")                        // Bullet (we draw our own)
    .replace(/\u2026/g, "...")                      // Ellipsis
    .replace(/\u2192/g, "->")                       // Right arrow
    .replace(/\u2190/g, "<-")                       // Left arrow
    .replace(/\u00B7/g, "-")                        // Middle dot
    .replace(/\u00A0/g, " ")                        // Non-breaking space
    .replace(/[^\x00-\xFF]/g, "");                  // Strip any remaining non-Latin-1
}

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
  const name = sanitizeForPdf(resume.contactInfo?.name || "Your Name");
  doc.text(name, pageWidth / 2, y, { align: "center" });
  y += 22;

  // Contact
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  const contact = [resume.contactInfo?.email, resume.contactInfo?.phone, resume.contactInfo?.location]
    .filter(Boolean).map(sanitizeForPdf).join("  |  ");
  if (contact) { doc.text(contact, pageWidth / 2, y, { align: "center" }); y += 14; }

  if (resume.contactInfo?.linkedin || resume.contactInfo?.portfolio) {
    const links = [resume.contactInfo.linkedin, resume.contactInfo.portfolio]
      .filter(Boolean).map(sanitizeForPdf).join("  |  ");
    doc.text(links, pageWidth / 2, y, { align: "center" });
    y += 14;
  }

  if (resume.contactInfo?.authorization) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(27, 42, 74);
    doc.text(sanitizeForPdf(resume.contactInfo.authorization), pageWidth / 2, y, { align: "center" });
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
    doc.text(sanitizeForPdf(text).toUpperCase(), margin, y);
    y += 16;
  };

  // Helper: wrapped text (sanitizes automatically)
  const wrappedText = (text: string, fontSize: number, bold = false, indent = 0) => {
    const clean = sanitizeForPdf(text);
    if (!clean) return;
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(fontSize);
    doc.setTextColor(50, 50, 50);
    const lines = doc.splitTextToSize(clean, contentWidth - indent);
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

  // Skills — normalize all AI output shapes, then render
  const pdfSkillEntries = normalizeSkills(resume.skills);
  if (pdfSkillEntries.length > 0) {
    heading("Skills");
    for (const entry of pdfSkillEntries) {
      wrappedText(sanitizeForPdf(`${entry.category}: ${entry.items.join(", ")}`), 10);
    }
    y += 4;
  }

  // Experience
  if (resume.experience?.length) {
    heading("Experience");
    for (const exp of resume.experience) {
      if (!exp) continue;
      checkPage(40);
      const role = sanitizeForPdf(String(exp.role || ""));
      const company = sanitizeForPdf(String(exp.company || ""));
      const startDate = sanitizeForPdf(String(exp.startDate || ""));
      const endDate = sanitizeForPdf(String(exp.endDate || "Present"));
      const location = sanitizeForPdf(String(exp.location || ""));
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
      const dateLine = [company, startDate && endDate ? `${startDate} - ${endDate}` : ""].filter(Boolean).join(" | ");
      if (dateLine) doc.text(dateLine, margin, y);
      y += 12;
      // Bullets
      for (const bullet of exp.bullets || []) {
        if (!bullet) continue;
        checkPage(14);
        const cleanBullet = sanitizeForPdf(String(bullet));
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(50, 50, 50);
        doc.text("-", margin + 8, y);
        const bulletLines = doc.splitTextToSize(cleanBullet, contentWidth - 28);
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
      const degree = sanitizeForPdf(String(edu.degree || ""));
      const year = sanitizeForPdf(String(edu.year || ""));
      const school = sanitizeForPdf(String(edu.school || ""));
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

  // Projects section omitted by design (2026-05-11) — see comment in the
  // docx path above. Tailoring prompt no longer emits a projects array;
  // legacy resumes that still have one render nothing.
  if (false && resume.projects?.length) {
    heading("Projects");
    for (const proj of resume.projects) {
      if (!proj) continue;
      checkPage(28);
      const projName = sanitizeForPdf(String(proj.name || ""));
      const projDesc = sanitizeForPdf(String(proj.description || ""));
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
