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

    // Pre-compute candidate and job country to help the AI with location logic.
    // This prevents the AI from suggesting cross-country relocation.
    const candidateLocation = (parsedResume?.contactInfo?.location || "").toLowerCase();
    const jobLocation = (parsedJob?.location || parsedJob?.jobLocation || "").toLowerCase();
    const jobDescription = (parsedJob?.description || parsedJob?.jobDescription || "").toLowerCase();

    const isCanadaCandidate = /canada|canadian|ontario|british columbia|alberta|quebec|manitoba|saskatchewan|nova scotia|new brunswick|bc|on\b|ab\b|qc\b|vancouver|toronto|montreal|calgary|ottawa|winnipeg|edmonton/i.test(candidateLocation);
    const isUSCandidate = /united states|usa|\bus\b|california|new york|texas|florida|washington|illinois|georgia|pennsylvania|ohio|sf|nyc|la\b|san francisco|los angeles|chicago|seattle|boston|austin/i.test(candidateLocation);

    const isCanadaJob = /canada|canadian|remote.*canada|toronto|vancouver|montreal|calgary|ottawa|winnipeg|edmonton|ontario|british columbia|alberta|quebec/i.test(jobLocation + " " + jobDescription);
    const isUSJob = /united states|usa|\bus\b|san francisco|new york|los angeles|chicago|seattle|boston|austin|california|texas|florida/i.test(jobLocation + " " + jobDescription);

    let locationWarning = "";
    if (isCanadaCandidate && isUSJob && !isCanadaJob) {
      locationWarning = "\n\nIMPORTANT LOCATION NOTE: The candidate is based in CANADA and the job appears to be in the UNITED STATES. Do NOT suggest relocating to any US city. Keep the candidate's Canadian location as-is.";
    } else if (isUSCandidate && isCanadaJob && !isUSJob) {
      locationWarning = "\n\nIMPORTANT LOCATION NOTE: The candidate is based in the UNITED STATES and the job appears to be in CANADA. Do NOT suggest relocating to any Canadian city. Keep the candidate's US location as-is.";
    } else if (isCanadaCandidate && isCanadaJob) {
      locationWarning = "\n\nIMPORTANT LOCATION NOTE: Both the candidate and job are in CANADA. You may suggest relocation to Canadian cities mentioned in the JD, but NEVER to any US city (e.g., San Francisco, New York, etc.).";
    }

    const message = await anthropic.messages.create({
      model: modelId,
      max_tokens: 8192,
      system: RESUME_TAILOR_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Here is the candidate's resume:\n${JSON.stringify(parsedResume, null, 2)}\n\nHere is the target job description:\n${JSON.stringify(parsedJob, null, 2)}${locationWarning}\n\nTailor the resume for this job.`,
        },
      ],
    });

    // [AutoQA fix 2026-04-07] Added optional chaining — content array could be empty if model returns no text block
    let responseText =
      message.content?.[0]?.type === "text" ? message.content[0].text : "";

    // Strip markdown code fences if present (Haiku sometimes adds these)
    responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

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
