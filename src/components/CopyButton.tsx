"use client";

import { useState } from "react";

/**
 * Tiny "Copy" button that copies a given string to clipboard and shows a
 * 1.5s "Copied!" confirmation. Designed to sit next to a heading or section.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  if (!text) return null;

  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Some browsers refuse clipboard write without user gesture / https.
          // Fall back to selecting + execCommand.
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          try { document.execCommand("copy"); } catch { /* tolerate */ }
          document.body.removeChild(ta);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className={`text-[11px] font-medium px-2 py-1 rounded transition-colors ${
        copied
          ? "bg-emerald-100 text-emerald-700"
          : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      {copied ? "✓ Copied" : `📋 ${label}`}
    </button>
  );
}
