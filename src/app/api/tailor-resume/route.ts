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

    // Extract the years-of-experience figure the candidate has already written
    // in their own summary — this is their deliberate marketing claim and must
    // be preserved verbatim. A resume is a marketing document; the candidate
    // may intentionally state "9+ years" even if individual role dates sum
    // differently. We read it from the source rather than recomputing.
    const sourceSummary: string = parsedResume?.summary || parsedResume?.professionalSummary || "";
    const yearsMatch = sourceSummary.match(/(\d{1,2}\+?\s*years?)/i);
    const experienceConstraint = yearsMatch
      ? `\n\n⚠️ MANDATORY EXPERIENCE CONSTRAINT — HIGHEST PRIORITY AFTER RULE ZERO:\nThe candidate's own summary states their experience as "${yearsMatch[1]}".\n- You MUST use this exact figure in the tailored summary — copy it verbatim.\n- Do NOT substitute a different number derived from individual role tenures (e.g. "4+ years at Amazon" is wrong if the source summary says "9+ years").\n- This is the candidate's deliberate self-presentation; do not second-guess it.`
      : "";

    const controller = new AbortController();
    // 90s hard cap. Haiku (fast mode) usually finishes in 10-20s and Sonnet
    // in 30-40s, but the API can be slow under load and we'd rather wait than
    // fail. Bumped 2026-05-06 after both Haiku attempts on a HOOPP submission
    // hit the previous 45s cap and aborted — the underlying SDK request
    // succeeds when given enough time.
    const timeout = setTimeout(() => controller.abort(), 90000);

    const message = await anthropic.messages.create({
      model: modelId,
      // 8192 tokens. Was lowered to 4096 for perf, but the wrapped output
      // (matchBreakdown + matchReasoning + tailoredResume + coverLetter +
      // changes) regularly exceeds 4096 for richer JDs, causing truncation
      // and JSON.parse failures that surface as HTTP 500 "AI returned
      // invalid format". Caught 2026-05-03 mid-batch (HOOPP FP&A retried
      // 3x and failed at the same step). Reliability > 40% latency saving.
      max_tokens: 8192,
      system: RESUME_TAILOR_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Here is the candidate's resume:\n${JSON.stringify(parsedResume, null, 2)}\n\nHere is the target job description:\n${JSON.stringify(parsedJob, null, 2)}${locationWarning}${experienceConstraint}\n\nTailor the resume for this job.`,
        },
      ],
    }, { signal: controller.signal });

    clearTimeout(timeout);

    // [AutoQA fix 2026-04-07] Added optional chaining — content array could be empty if model returns no text block
    let responseText =
      message.content?.[0]?.type === "text" ? message.content[0].text : "";

    // Strip markdown code fences if present (Haiku sometimes adds these)
    responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    // [Fix 2026-04-08] More robust JSON extraction: if stripping code fences wasn't enough
    // (e.g. model added preamble like "Here is the tailored resume:"), extract the outermost
    // JSON object by finding the first { and last } to handle cases where the model wraps
    // the JSON in prose. This prevents the occasional 500 "AI returned invalid format" error.
    if (!responseText.startsWith("{")) {
      const firstBrace = responseText.indexOf("{");
      const lastBrace = responseText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        responseText = responseText.slice(firstBrace, lastBrace + 1);
      }
    }

    // Pre-parse sanity check: response must start with { (avoids confusing SyntaxError messages)
    if (!responseText || !responseText.trimStart().startsWith("{")) {
      console.error("Tailor-resume: model returned non-JSON:", responseText.substring(0, 200));
      return NextResponse.json(
        { error: "AI returned unexpected format. Please try again." },
        { status: 500 }
      );
    }

    const tailoredResult = JSON.parse(responseText);

    // Schema guard: tailored output must have at minimum an experience array and contactInfo
    if (!tailoredResult || typeof tailoredResult !== "object") {
      return NextResponse.json(
        { error: "AI returned an empty tailoring result. Please try again." },
        { status: 500 }
      );
    }
    if (!tailoredResult.experience && !tailoredResult.tailoredResume) {
      return NextResponse.json(
        { error: "AI output is missing required fields. Please try again." },
        { status: 422 }
      );
    }

    // ── RULE ZERO ENFORCEMENT (server-side date & identity sanitization) ──
    // [AutoQA fix 2026-04-13] Rather than rejecting Claude's output when it
    // alters immutable fields, we overwrite those fields with the source
    // values. This makes RULE ZERO physically unviolatable and prevents
    // the "AI altered employment dates" error from ever surfacing to users.
    // Matching strategy: company + title (case-insensitive, whitespace-
    // normalized). Falls back to position-index match if no key match.
    const sanitizeRuleZero = (tailored: Record<string, unknown>) => {
      if (!tailored || typeof tailored !== "object") return tailored;

      const norm = (s: unknown) =>
        String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

      // 1) Contact info — name, email, phone must never change
      if (parsedResume.contactInfo && tailored.contactInfo) {
        const srcC = parsedResume.contactInfo;
        const tgtC = tailored.contactInfo as Record<string, unknown>;
        if (srcC.name) tgtC.name = srcC.name;
        if (srcC.email) tgtC.email = srcC.email;
        if (srcC.phone) tgtC.phone = srcC.phone;
      }

      // 2) Experience dates, company, title — copy verbatim from source
      const srcExp: Array<Record<string, unknown>> = Array.isArray(
        parsedResume.experience
      )
        ? parsedResume.experience
        : [];
      const tgtExp: Array<Record<string, unknown>> = Array.isArray(tailored.experience)
        ? (tailored.experience as Array<Record<string, unknown>>)
        : [];

      // [AutoQA fix 2026-05-01] ParsedResume.experience uses `role`, NOT `title`
      // (see useAppStore.ts ParsedResume interface). Claude's tailored output may
      // mirror the input (`role`) or use `title` based on its own convention. The
      // previous code compared only `s.title === t.title` — both undefined for
      // the source, so the title-equality leg was effectively a no-op and the
      // intended SACRED title overwrite at line 195 never fired. Now we read
      // `role || title` from both sides so the matcher and the overwrite both
      // work regardless of which key Claude emits.
      const expTitle = (s: Record<string, unknown>) => s.role ?? s.title;
      for (let i = 0; i < tgtExp.length; i++) {
        const t = tgtExp[i];
        // Find matching source role: company + title/role match, else position
        let match = srcExp.find(
          (s) =>
            norm(s.company) === norm(t.company) &&
            norm(expTitle(s)) === norm(expTitle(t))
        );
        if (!match) {
          match = srcExp.find((s) => norm(s.company) === norm(t.company));
        }
        if (!match && srcExp[i]) {
          match = srcExp[i];
        }
        if (match) {
          // Dates are SACRED — copy verbatim
          t.startDate = match.startDate;
          t.endDate = match.endDate;
          // Company name is SACRED
          if (match.company) t.company = match.company;
          // Title/role is SACRED — Claude may not rename it. Overwrite whichever
          // key Claude used in the tailored output with the source's role/title.
          const sacredTitle = expTitle(match);
          if (sacredTitle) {
            if ("title" in t) t.title = sacredTitle;
            if ("role"  in t) t.role  = sacredTitle;
            // If Claude emitted neither key, mirror the source's key choice.
            if (!("title" in t) && !("role" in t)) {
              if ("title" in match) t.title = sacredTitle;
              else t.role = sacredTitle;
            }
          }
          // Location is SACRED
          if (match.location) t.location = match.location;
        }
      }

      // 3) Education dates and degrees — copy verbatim
      const srcEdu: Array<Record<string, unknown>> = Array.isArray(parsedResume.education)
        ? parsedResume.education
        : [];
      const tgtEdu: Array<Record<string, unknown>> = Array.isArray(tailored.education)
        ? (tailored.education as Array<Record<string, unknown>>)
        : [];
      // [AutoQA fix 2026-05-01] ParsedResume.education uses `school` and `year`
      // (NOT `institution` / `startDate` / `endDate`). The previous code matched
      // on `institution` only, so source-side comparisons returned undefined and
      // the SACRED overwrites for school/year never fired — Claude could quietly
      // rewrite either field. Read both key conventions defensively.
      const eduSchool = (s: Record<string, unknown>) => s.school ?? s.institution;
      for (let i = 0; i < tgtEdu.length; i++) {
        const t = tgtEdu[i];
        const match =
          srcEdu.find(
            (s) =>
              norm(eduSchool(s)) === norm(eduSchool(t)) &&
              norm(s.degree) === norm(t.degree)
          ) ||
          srcEdu.find((s) => norm(eduSchool(s)) === norm(eduSchool(t))) ||
          srcEdu[i];
        if (match) {
          // Dates / year — copy verbatim under whichever key the tailored entry uses
          if (match.startDate) t.startDate = match.startDate;
          if (match.endDate) t.endDate = match.endDate;
          if (match.year) {
            if ("year" in t) t.year = match.year;
            if ("startDate" in t && !match.startDate) t.startDate = match.year;
          }
          if (match.degree) t.degree = match.degree;
          // School — overwrite under whichever key the tailored entry uses.
          const sacredSchool = eduSchool(match);
          if (sacredSchool) {
            if ("institution" in t) t.institution = sacredSchool;
            if ("school" in t)      t.school      = sacredSchool;
            if (!("institution" in t) && !("school" in t)) {
              if ("school" in match) t.school = sacredSchool;
              else t.institution = sacredSchool;
            }
          }
        }
      }

      return tailored;
    };

    if (tailoredResult.tailoredResume) {
      tailoredResult.tailoredResume = sanitizeRuleZero(tailoredResult.tailoredResume);
    } else if (tailoredResult.experience) {
      sanitizeRuleZero(tailoredResult);
    }

    return NextResponse.json({ tailoredResult, usage: message.usage });
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
