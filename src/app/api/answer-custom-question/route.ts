import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * API ROUTE: POST /api/answer-custom-question
 *
 * Generates a concise, authentic answer for a custom ATS application question.
 * Used by the extension when it encounters open-ended questions it can't fill
 * from the user's profile (e.g. "Describe how you use AI in your work").
 *
 * Body: { question: string, resumeSummary: string, jobTitle: string, company: string, jobDescription?: string }
 * Returns: { answer: string }
 *
 * [Fix 2026-04-13] Added optional `jobDescription` so answers can be grounded
 * in the actual JD text — not just the job title + company. This closes a
 * cross-contamination vector: if an ATS script held stale `pendingApplication`
 * from a previous job, the old answer-generation path would produce text
 * aligned with the previous job's title/company. Passing the JD forces the
 * model to ground every answer in the posting the user is actually looking at.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  try {
    const { question, resumeSummary, jobTitle, company, jobDescription } = await request.json();

    if (!question) {
      return NextResponse.json({ error: "question is required" }, { status: 400, headers: CORS_HEADERS });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === "your-api-key-here") {
      return NextResponse.json(
        { error: "Anthropic API key not configured." },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const anthropic = new Anthropic({ apiKey });

    const systemPrompt = `You are a career coach helping a job candidate answer custom application questions.
Write a concise, authentic, first-person answer (3-5 sentences) that:
- Directly answers the question asked
- Is grounded in the candidate's real background (given in the user message)
- Uses specific examples where relevant
- Sounds natural and human, NOT like a generic template
- Is appropriate length for a text field in a job application form

CRITICAL RULES:
- NEVER ask the candidate for more information. You must ALWAYS produce an answer.
- If the candidate summary is sparse, infer reasonable details from their job title, company, and the question context.
- Write as if you ARE the candidate — use "I", "my", "we" naturally.
- NEVER output meta-commentary like "I don't have your background" or "Could you share..." — that would be filled into a form field and is embarrassing.
Return ONLY the answer text — no preamble, no labels, no quotes.`;

    // If a JD is available, include a trimmed version (first ~1500 chars) so
    // the answer can reference actual responsibilities/tech stack/mission —
    // not generic language inferred from title + company alone.
    const jdSection = jobDescription && typeof jobDescription === "string" && jobDescription.trim().length > 50
      ? `\nJob description (for grounding — reference specific points):\n${jobDescription.trim().slice(0, 1500)}\n`
      : "";

    const userContent = `Candidate applying to: ${jobTitle || "a role"} at ${company || "a company"}
Candidate summary: ${resumeSummary || "(no summary provided)"}${jdSection}

Application question: ${question}

Write the answer:`;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const answer = message.content?.[0]?.type === "text"
      ? message.content[0].text.trim()
      : "";

    return NextResponse.json({ answer }, { headers: CORS_HEADERS });
  } catch (error: unknown) {
    console.error("answer-custom-question error:", error);
    return NextResponse.json(
      { error: "Failed to generate answer." },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
