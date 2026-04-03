import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { RESUME_TAILOR_SYSTEM } from "@/lib/prompts";

/**
 * API ROUTE: POST /api/tailor-resume
 *
 * THE CORE ENGINE. This is where the magic happens.
 *
 * Takes a parsed resume + parsed job description, and asks Claude to:
 * 1. Score the match (0-100)
 * 2. Rewrite the resume to maximize relevance
 * 3. Generate a tailored cover letter
 * 4. List what it changed and why
 *
 * This single endpoint is what makes our product work.
 */

export async function POST(request: NextRequest) {
  try {
    const { parsedResume, parsedJob, mode } = await request.json();

    if (!parsedResume || !parsedJob) {
      return NextResponse.json(
        { error: "Both a parsed resume and parsed job are required." },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === "your-api-key-here") {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Add it to .env.local" },
        { status: 500 }
      );
    }

    // Model selection: "fast" = Haiku (cheap), "pro" = Sonnet (better quality)
    const modelId =
      mode === "fast"
        ? "claude-haiku-4-5-20251001"
        : "claude-sonnet-4-20250514";

    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: modelId,
      max_tokens: 8192,
      system: RESUME_TAILOR_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Here is the candidate's resume:\n${JSON.stringify(parsedResume, null, 2)}\n\nHere is the target job description:\n${JSON.stringify(parsedJob, null, 2)}\n\nTailor the resume for this job.`,
        },
      ],
    });

    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";
    const tailoredResult = JSON.parse(responseText);

    return NextResponse.json({ tailoredResult });
  } catch (error: unknown) {
    console.error("Tailoring error:", error);
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "AI returned invalid format. Please try again." },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: "Failed to tailor resume. Check your API key and try again." },
      { status: 500 }
    );
  }
}
