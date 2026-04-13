import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { RESUME_PARSER_SYSTEM } from "@/lib/prompts";

/**
 * API ROUTE: POST /api/parse-resume
 *
 * HOW API ROUTES WORK IN NEXT.JS:
 * - This file lives at src/app/api/parse-resume/route.ts
 * - Next.js automatically maps it to the URL: /api/parse-resume
 * - The function name "POST" means it handles POST requests
 *   (POST = sending data TO the server, like uploading a resume)
 *
 * FLOW:
 * 1. Browser sends resume text to this endpoint
 * 2. This code sends that text to Claude with our parsing prompt
 * 3. Claude returns structured JSON
 * 4. We send that JSON back to the browser
 *
 * The browser NEVER talks to Claude directly. This keeps our API key secret.
 */

export async function POST(request: NextRequest) {
  try {
    // Step 1: Get the resume text from the request
    const { resumeText } = await request.json();

    if (!resumeText || typeof resumeText !== "string" || resumeText.trim().split(/\s+/).length < 20) {
      return NextResponse.json(
        { error: "Resume text is too short. Please paste your full resume (at least 20 words)." },
        { status: 400 }
      );
    }

    // Step 2: Check that we have an API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === "your-api-key-here") {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Add it to .env.local" },
        { status: 500 }
      );
    }

    // Step 3: Call Claude (with 30s timeout)
    const anthropic = new Anthropic({ apiKey });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",  // Haiku — fast & cheap, perfect for extraction
      max_tokens: 4096,
      system: RESUME_PARSER_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Parse the following resume into structured JSON:\n\n${resumeText}`,
        },
      ],
    });
    clearTimeout(timeout);

    // Step 4: Extract the text response and clean it
    let responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Strip markdown code fences if present (Haiku sometimes adds these)
    responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    // [Fix 2026-04-08] Extract outermost JSON object if model added preamble prose
    if (!responseText.startsWith("{")) {
      const firstBrace = responseText.indexOf("{");
      const lastBrace = responseText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        responseText = responseText.slice(firstBrace, lastBrace + 1);
      }
    }

    // Step 5: Parse and validate the JSON
    const parsedResume = JSON.parse(responseText);

    // Schema guard: ensure we got a usable resume object, not an empty/null result
    if (!parsedResume || typeof parsedResume !== "object") {
      return NextResponse.json(
        { error: "AI returned an empty result. Please try again." },
        { status: 500 }
      );
    }
    if (!parsedResume.contactInfo && !parsedResume.experience) {
      return NextResponse.json(
        { error: "AI could not extract resume data. Please check your resume text and try again." },
        { status: 422 }
      );
    }

    return NextResponse.json({ parsedResume });
  } catch (error: unknown) {
    console.error("Resume parsing error:", error);

    // If JSON parsing failed, Claude probably returned something unexpected
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "AI returned invalid format. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "Failed to parse resume. Check your API key and try again." },
      { status: 500 }
    );
  }
}
