"use client";

import { useState, useCallback } from "react";
import { useAppStore } from "@/store/useAppStore";

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

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setError("");
      const name = file.name.toLowerCase();

      if (name.endsWith(".txt") || name.endsWith(".md")) {
        const reader = new FileReader();
        reader.onload = (event) => setText(event.target?.result as string);
        reader.readAsText(file);
      } else if (name.endsWith(".pdf") || name.endsWith(".docx")) {
        setIsUploading(true);
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/upload-resume", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();
          if (!res.ok) { setError(data.error || "Failed to process file."); return; }
          setText(data.text);
        } catch {
          setError("Failed to upload file. Try pasting instead.");
        } finally {
          setIsUploading(false);
        }
      } else {
        setError("Upload a PDF, DOCX, or TXT file.");
      }
    },
    []
  );

  const handleParse = async () => {
    if (text.trim().length < 50) {
      setError("Paste your full resume (at least a few paragraphs).");
      return;
    }
    setError("");
    setIsParsingResume(true);
    setRawResumeText(text);
    try {
      const res = await fetch("/api/parse-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeText: text }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Something went wrong."); return; }
      setParsedResume(data.parsedResume);
    } catch {
      setError("Network error. Is the dev server running?");
    } finally {
      setIsParsingResume(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-semibold text-indigo-400">01</span>
            <h2 className="text-sm font-semibold text-neutral-900">Your resume</h2>
          </div>
          <p className="text-[13px] text-neutral-400 mt-0.5 ml-7">
            Upload a file or paste text
          </p>
        </div>

        {/* File upload */}
        <label className="cursor-pointer">
          <span className="text-[13px] text-neutral-500 hover:text-indigo-600 border border-neutral-200 px-3 py-1.5 rounded-lg hover:border-indigo-200 hover:bg-indigo-50 transition-colors inline-flex items-center gap-1.5">
            {isUploading ? (
              <>
                <Spinner />
                Extracting...
              </>
            ) : (
              <>
                <UploadIcon />
                Upload file
              </>
            )}
          </span>
          <input
            type="file"
            accept=".txt,.md,.pdf,.docx"
            className="hidden"
            onChange={handleFileUpload}
            disabled={isUploading}
          />
        </label>
      </div>

      {fileName && (
        <div className="flex items-center gap-1.5 text-[13px] text-emerald-600 ml-7">
          <CheckIcon /> {fileName}
        </div>
      )}

      <textarea
        className="w-full h-48 p-4 bg-neutral-50 border border-neutral-200 rounded-lg text-sm font-mono text-neutral-700 placeholder:text-neutral-300 focus:outline-none focus:ring-1 focus:ring-indigo-200 focus:border-indigo-200 resize-y transition-all"
        placeholder="Paste your resume text here..."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {error && (
        <p className="text-[13px] text-red-500 animate-fade-in">{error}</p>
      )}

      <button
        onClick={handleParse}
        disabled={isParsingResume || isUploading || text.trim().length < 50}
        className="text-sm font-medium bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed transition-colors"
      >
        {isParsingResume ? (
          <span className="flex items-center gap-2">
            <Spinner /> Parsing...
          </span>
        ) : (
          "Parse resume"
        )}
      </button>

      {parsedResume && (
        <div className="border border-emerald-200 bg-emerald-50/50 rounded-lg p-4 animate-fade-up">
          <p className="text-sm font-medium text-emerald-700 flex items-center gap-1.5 mb-2">
            <CheckIcon /> Parsed successfully
          </p>
          <div className="text-[13px] text-emerald-600/80 space-y-0.5 ml-5">
            <p>{parsedResume.contactInfo.name}</p>
            <p>{[...parsedResume.skills.technical, ...parsedResume.skills.tools].slice(0, 5).join(", ")}{[...parsedResume.skills.technical, ...parsedResume.skills.tools].length > 5 && " ..."}</p>
            <p>{parsedResume.experience.length} roles, {parsedResume.education.length} education</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <span className="animate-spin h-3 w-3 border-[1.5px] border-current border-t-transparent rounded-full inline-block" />;
}
function UploadIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>;
}
function CheckIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7"/></svg>;
}
