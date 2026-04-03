"use client";

import { useState, useCallback } from "react";
import { useAppStore } from "@/store/useAppStore";

/**
 * ResumeUploader — Lets users paste, or upload PDF/DOCX/TXT resumes.
 *
 * Three input methods:
 * 1. Paste text directly into a textarea
 * 2. Upload a PDF file (server extracts text)
 * 3. Upload a DOCX file (server extracts text)
 *
 * Files are sent to /api/upload-resume for text extraction,
 * then the extracted text goes to /api/parse-resume for AI parsing.
 */
export default function ResumeUploader() {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const {
    parsedResume,
    isParsingResume,
    setRawResumeText,
    setParsedResume,
    setIsParsingResume,
  } = useAppStore();

  /**
   * Handle file upload — sends PDF/DOCX to server for text extraction.
   * TXT/MD files are read directly in the browser (no server needed).
   */
  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setError("");
      const name = file.name.toLowerCase();

      if (name.endsWith(".txt") || name.endsWith(".md")) {
        // Text files: read directly in the browser
        const reader = new FileReader();
        reader.onload = (event) => {
          setText(event.target?.result as string);
        };
        reader.readAsText(file);
      } else if (name.endsWith(".pdf") || name.endsWith(".docx")) {
        // PDF and DOCX: send to server for extraction
        setIsUploading(true);
        try {
          const formData = new FormData();
          formData.append("file", file);

          const response = await fetch("/api/upload-resume", {
            method: "POST",
            body: formData,
          });

          const data = await response.json();

          if (!response.ok) {
            setError(data.error || "Failed to process file.");
            return;
          }

          setText(data.text);
        } catch {
          setError("Failed to upload file. Try pasting your resume instead.");
        } finally {
          setIsUploading(false);
        }
      } else {
        setError("Please upload a PDF, DOCX, or TXT file.");
      }
    },
    []
  );

  /**
   * Parse the resume — sends text to /api/parse-resume which calls Claude.
   */
  const handleParse = async () => {
    if (text.trim().length < 50) {
      setError("Please paste your full resume (at least a few paragraphs).");
      return;
    }

    setError("");
    setIsParsingResume(true);
    setRawResumeText(text);

    try {
      const response = await fetch("/api/parse-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeText: text }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }

      setParsedResume(data.parsedResume);
    } catch {
      setError("Network error. Make sure the dev server is running.");
    } finally {
      setIsParsingResume(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-navy">Step 1: Your Resume</h2>
      <p className="text-sm text-gray-500">
        Upload your resume as PDF, Word (.docx), or plain text — or paste it
        below. We&apos;ll parse it into structured data that can be tailored for
        any job.
      </p>

      {/* File upload — now supports PDF, DOCX, TXT */}
      <div className="flex items-center gap-4">
        <label className="cursor-pointer bg-white border border-gray-300 rounded-lg px-4 py-2 text-sm hover:bg-gray-50 transition-colors">
          {isUploading ? (
            <span className="flex items-center gap-2">
              <span className="animate-spin h-3 w-3 border-2 border-gray-500 border-t-transparent rounded-full" />
              Extracting text...
            </span>
          ) : (
            "Upload PDF, DOCX, or TXT"
          )}
          <input
            type="file"
            accept=".txt,.md,.pdf,.docx"
            className="hidden"
            onChange={handleFileUpload}
            disabled={isUploading}
          />
        </label>
        {fileName && (
          <span className="text-sm text-gray-500">Loaded: {fileName}</span>
        )}
      </div>

      {/* Text area */}
      <textarea
        className="w-full h-64 p-4 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent resize-y"
        placeholder={`Paste your resume here, or upload a file above...

Example:
John Doe
john@email.com | (555) 123-4567 | San Francisco, CA

PROFESSIONAL SUMMARY
Product manager with 5 years of experience in B2B SaaS...

EXPERIENCE
Senior Product Manager | Acme Corp | Jan 2022 - Present
- Led cross-functional team of 12 to launch new analytics platform
- Increased user retention by 25% through data-driven feature prioritization
...`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {/* Error message */}
      {error && (
        <p className="text-sm text-red-500 bg-red-50 p-3 rounded-lg">
          {error}
        </p>
      )}

      {/* Parse button */}
      <button
        onClick={handleParse}
        disabled={isParsingResume || isUploading || text.trim().length < 50}
        className="bg-brand-500 hover:bg-brand-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium px-6 py-3 rounded-lg transition-colors"
      >
        {isParsingResume ? (
          <span className="flex items-center gap-2">
            <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            Parsing with AI...
          </span>
        ) : (
          "Parse Resume"
        )}
      </button>

      {/* Show parsed result */}
      {parsedResume && (
        <div className="mt-6 bg-green-50 border border-green-200 rounded-lg p-4">
          <h3 className="font-semibold text-green-800 mb-2">
            Resume Parsed Successfully!
          </h3>
          <div className="text-sm text-green-700 space-y-1">
            <p>
              <strong>Name:</strong> {parsedResume.contactInfo.name}
            </p>
            <p>
              <strong>Skills found:</strong>{" "}
              {[
                ...parsedResume.skills.technical,
                ...parsedResume.skills.tools,
              ].join(", ")}
            </p>
            <p>
              <strong>Experience:</strong> {parsedResume.experience.length}{" "}
              positions
            </p>
            <p>
              <strong>Education:</strong> {parsedResume.education.length}{" "}
              entries
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
