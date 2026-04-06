import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * API ROUTE: POST /api/answer-custom-question
 *
 * Generates a concise, authentic answer for a custom ATS application question.
 * Used by the extension when it encounters open-ended questions it can't fill
 * from the user's profile (e.g. "Describe how you use AI in your work").
 *
 * Body: { question: string, resumeSummary: string, jobTitle: string, company: string }
 * Returns: { answer: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { question, resumeSummary, jobTitle, company } = await request.json();

    if (!question) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === "your-api-key-here") {
      return NextResponse.json(
        { error: "Anthropic API key not configured." },
        { status: 500 }
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
Return ONLY the answer text — no preamble, no labels, no quotes.`;

    const userContent = `Candidate applying to: ${jobTitle || "a role"} at ${company || "a company"}
Candidate summary: ${resumeSummary || "(no summary provided)"}

Application question: ${question}

Write the answer:`;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const answer = message.content[0].type === "text"
      ? message.content[0].text.trim()
      : "";

    return NextResponse.json({ answer });
  } catch (error: unknown) {
    console.error("answer-custom-question error:", error);
    return NextResponse.json(
      { error: "Failed to generate answer." },
      { status: 500 }
    );
  }
}
