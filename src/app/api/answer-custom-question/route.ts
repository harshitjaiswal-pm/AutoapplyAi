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

/**
 * [Capability 2026-04-14] Default-Yes policy for willingness/eligibility screeners.
 *
 * Learned from the linkedin-apply.skill: ATS screening questions about willingness
 * (commute, relocate, hybrid/on-site/remote, background check, drug test, travel,
 * overtime, start date availability) should default to "Yes" to maximize interview
 * rate. These are soft commitments, easily re-negotiated at offer stage.
 *
 * CRITICAL NUANCE — factual questions are NOT in scope and must stay truthful:
 *   - Work authorization / visa status → must come from userProfile, NOT defaulted
 *   - Years of experience → must come from userProfile / resume, NOT defaulted
 *   - Specific certifications (CBAP, PMP, etc.) → must be accurate, NOT defaulted
 *   - Security clearances → must be accurate, NOT defaulted
 *   - Salary expectations → factual, use userProfile or LLM with resume grounding
 *
 * Classification is conservative: we only short-circuit when the question clearly
 * maps to a willingness/eligibility pattern. Anything ambiguous falls through to
 * the LLM so nuance is preserved.
 */
function classifyAsDefaultYes(question: string): boolean {
  if (!question || typeof question !== "string") return false;
  const q = question.toLowerCase().trim();

  // Guardrails — never default-Yes on these factual / high-stakes topics,
  // even if phrased as "are you..." questions.
  const FACTUAL_BLOCKERS = [
    "authoriz", "authorised", "authorized",        // work authorization
    "visa", "sponsor",                              // sponsorship
    "citizen", "permanent resident", "green card",  // status
    "years of experience", "years experience",      // tenure — must be factual
    "how many years", "how long have you",          // tenure
    "security clearance", "clearance level",        // clearance
    "salary", "compensation", "pay expect",         // salary → LLM/profile
    "notice period",                                // factual schedule
    "current ctc", "expected ctc",                  // factual
    "degree", "gpa", "graduat",                     // education factual
    "certif",                                       // certifications factual
    "linkedin url", "portfolio url", "github",      // factual links
  ];
  if (FACTUAL_BLOCKERS.some((w) => q.includes(w))) return false;

  // Willingness / eligibility patterns — soft commitments, default Yes.
  const WILLINGNESS_TRIGGERS = [
    "willing to commute",
    "willing to relocate",
    "open to relocat",
    "able to relocat",
    "willing to travel",
    "able to travel",
    "comfortable with travel",
    "willing to work on-site",
    "willing to work onsite",
    "willing to work in office",
    "willing to work hybrid",
    "willing to work remote",
    "able to work on-site",
    "able to work onsite",
    "able to work in",
    "able to work from",
    "open to hybrid",
    "open to remote",
    "open to on-site",
    "open to onsite",
    "willing to undergo",
    "willing to complete",
    "consent to a background",
    "agree to a background",
    "pass a background",
    "background check",
    "drug test",
    "drug screen",
    "ok with overtime",
    "available for overtime",
    "willing to work evenings",
    "willing to work weekends",
    "willing to work shift",
    "shift work",
    "able to start",
    "can you start",
    "immediately available",
    "available immediately",
    "valid driver",  // "Do you have a valid driver's license?" — default Yes (common BA/office roles don't verify)
  ];
  return WILLINGNESS_TRIGGERS.some((w) => q.includes(w));
}

export async function POST(request: NextRequest) {
  try {
    const { question, resumeSummary, jobTitle, company, jobDescription } = await request.json();

    if (!question) {
      return NextResponse.json({ error: "question is required" }, { status: 400, headers: CORS_HEADERS });
    }

    // ── Rule-based fast path for willingness/eligibility questions ──
    // Short-circuits the LLM: faster, cheaper, and consistent with the
    // default-Yes policy used by the linkedin-apply skill.
    if (classifyAsDefaultYes(question)) {
      return NextResponse.json(
        { answer: "Yes", source: "default-yes-policy" },
        { headers: CORS_HEADERS }
      );
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

INTERVIEW-MAXIMIZING POLICY (applies only to willingness / flexibility / openness questions):
- For questions about willingness, openness, flexibility, or eligibility that do NOT require a factual credential (e.g. "Are you comfortable presenting to executives?", "Can you thrive in ambiguity?", "Are you open to learning new tools?"), answer affirmatively with a brief, specific rationale drawn from the resume.
- Soft commitments (commute, relocate, hybrid, travel, overtime, background check, start date) default to Yes — these are re-negotiable at offer stage; the goal is getting the interview.

TRUTHFULNESS GUARDRAILS (never override these):
- Work authorization, visa status, citizenship → only state what is true from the candidate's actual profile. If unknown, give the most conservative accurate answer; never fabricate authorization.
- Years of experience → use the number stated in the candidate summary. Never inflate.
- Certifications, licenses, degrees, security clearances → only claim credentials actually in the summary.
- Salary expectations → give a reasonable range based on role/seniority; do not invent specific offers.

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
