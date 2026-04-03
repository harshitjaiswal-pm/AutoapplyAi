import { NextRequest, NextResponse } from "next/server";

/**
 * API ROUTE: POST /api/upload-resume
 *
 * Handles file uploads for PDF and DOCX resumes.
 * Extracts the text content and returns it so the frontend
 * can then send it to /api/parse-resume for AI parsing.
 *
 * WHY A SEPARATE ROUTE?
 * File processing (PDF parsing, DOCX extraction) requires Node.js
 * libraries that only run on the server. The browser can read the
 * file as bytes, but it can't parse PDF or DOCX formats.
 */

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    const fileName = file.name.toLowerCase();
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    let extractedText = "";

    if (fileName.endsWith(".pdf")) {
      // PDF extraction
      const pdfParse = (await import("pdf-parse")).default;
      const pdfData = await pdfParse(buffer);
      extractedText = pdfData.text;
    } else if (fileName.endsWith(".docx")) {
      // DOCX extraction using mammoth
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (fileName.endsWith(".txt") || fileName.endsWith(".md")) {
      // Plain text — just decode
      extractedText = buffer.toString("utf-8");
    } else {
      return NextResponse.json(
        { error: "Unsupported file type. Please upload a PDF, DOCX, or TXT file." },
        { status: 400 }
      );
    }

    if (extractedText.trim().length < 30) {
      return NextResponse.json(
        { error: "Could not extract enough text from the file. Try pasting your resume instead." },
        { status: 400 }
      );
    }

    return NextResponse.json({ text: extractedText });
  } catch (error: unknown) {
    console.error("File upload error:", error);
    return NextResponse.json(
      { error: "Failed to process file. Try pasting your resume text instead." },
      { status: 500 }
    );
  }
}
