import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { JOB_ANALYZER_SYSTEM } from "@/lib/prompts";

/**
 * API ROUTE: POST /api/analyze-job
 *
 * Same pattern as parse-resume, but for job descriptions.
 * Browser sends JD text → we ask Claude to analyze it → return structured data.
 */

export async function POST(request: NextRequest) {
  try {
    const { jobDescription } = await request.json();

    if (!jobDescription || jobDescription.trim().length < 50) {
      return NextResponse.json(
        { error: "Job description is too short. Paste the full posting." },
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

    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",  // Haiku — fast & cheap, perfect for extraction
      max_tokens: 4096,
      system: JOB_ANALYZER_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Analyze this job description:\n\n${jobDescription}`,
        },
      ],
    });

    let responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Strip markdown code fences if present (Haiku sometimes adds these)
    responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    const parsedJob = JSON.parse(responseText);

    return NextResponse.json({ parsedJob });
  } catch (error: unknown) {
    console.error("Job analysis error:", error);
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "AI returned invalid format. Please try again." },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: "Failed to analyze job. Check your API key and try again." },
      { status: 500 }
    );
  }
}
