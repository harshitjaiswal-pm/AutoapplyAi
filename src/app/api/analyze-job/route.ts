import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { JOB_ANALYZER_SYSTEM } from "@/lib/prompts";
import { authorize } from "@/lib/apiAuth";

/**
 * API ROUTE: POST /api/analyze-job
 *
 * Same pattern as parse-resume, but for job descriptions.
 * Browser sends JD text → we ask Claude to analyze it → return structured data.
 */

export async function POST(request: NextRequest) {
  try {
    const auth = await authorize(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
    const controller = new AbortController();
    // 20s hard cap — Haiku typically finishes in 3-8s for job analysis.
    // Signal is passed to the SDK so the in-flight request actually cancels.
    const timeout = setTimeout(() => controller.abort(), 20000);

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
    }, { signal: controller.signal });
    clearTimeout(timeout);

    let responseText =
      message.content?.[0]?.type === "text" ? message.content[0].text : "";

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

    const parsedJob = JSON.parse(responseText);

    // Schema guard: ensure we got a usable job object
    if (!parsedJob || typeof parsedJob !== "object") {
      return NextResponse.json(
        { error: "AI returned an empty result. Please try again." },
        { status: 500 }
      );
    }
    if (!parsedJob.title && !parsedJob.jobTitle && !parsedJob.skills && !parsedJob.requirements) {
      return NextResponse.json(
        { error: "AI could not extract job data. Please check the job description and try again." },
        { status: 422 }
      );
    }

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
