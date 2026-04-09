import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * API ROUTE: POST /api/chat
 *
 * Conversational assistant for the Chrome Extension chatbot panel.
 * Receives a message + optional page context (URL, title, visible text, selected element)
 * and returns a helpful reply.
 *
 * CORS is open so Chrome extension content scripts can call this directly.
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

const CHAT_SYSTEM = `You are a helpful job search assistant built into a browser extension called AutoApply.

You have access to the current page context when the user shares it (URL, page title, and visible text content). Use this to answer questions, give advice, and help the user take action.

## What you can help with
- Reading and summarizing job descriptions on the current page
- Advising whether a job is a good match based on the user's profile
- Explaining confusing requirements or jargon in a job posting
- Answering questions about the application process
- Pointing out what fields to fill in on an application form
- Suggesting how to respond to open-ended application questions
- General career and job search advice

## Guidelines
- Be concise and direct — users are busy and mid-application
- When analyzing a job page, proactively mention match signals, red flags, and salary cues
- When on an application form, help the user understand what's being asked and suggest strong answers
- If the user points at a specific element on the page, focus your answer on that element
- Keep responses under 200 words unless the user asks for detail
- Use plain text, not markdown headers — this is a chat panel not a document
- Never make up information about a company or role — only use what's in the page context

## Tone
Friendly, knowledgeable, like a career-savvy friend — not a formal assistant.`;

interface Message {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: NextRequest) {
  try {
    const { messages, pageContext, systemContext } = await request.json() as {
      messages: Message[];
      pageContext?: {
        url?: string;
        title?: string;
        text?: string;
        selectedElement?: string;
      };
      systemContext?: string;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "No messages provided." }, { status: 400, headers: CORS_HEADERS });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === "your-api-key-here") {
      return NextResponse.json(
        { error: "Anthropic API key not configured." },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const anthropic = new Anthropic({ apiKey });

    // Build context prefix to inject into first user message
    let contextBlock = "";
    if (pageContext) {
      const parts: string[] = [];
      if (pageContext.url)   parts.push(`Page URL: ${pageContext.url}`);
      if (pageContext.title) parts.push(`Page title: ${pageContext.title}`);
      if (pageContext.selectedElement) {
        parts.push(`\nUser pointed at this element:\n${pageContext.selectedElement}`);
      }
      if (pageContext.text && pageContext.text.trim().length > 0) {
        // Truncate to avoid hitting context limits
        const truncated = pageContext.text.slice(0, 6000);
        parts.push(`\nPage content:\n${truncated}${pageContext.text.length > 6000 ? "\n[...truncated]" : ""}`);
      }
      if (parts.length > 0) {
        contextBlock = `[Page context]\n${parts.join("\n")}\n\n`;
      }
    }

    // Inject page context into the first user message
    const apiMessages: Message[] = messages.map((m, i) => {
      if (i === 0 && m.role === "user" && contextBlock) {
        return { role: "user", content: contextBlock + m.content };
      }
      return m;
    });

    // Use the client-supplied systemContext (includes user profile + job context)
    // if provided; otherwise fall back to the default system prompt.
    const systemPrompt = systemContext && systemContext.trim().length > 0
      ? systemContext
      : CHAT_SYSTEM;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: apiMessages,
    });

    const reply = response.content[0].type === "text" ? response.content[0].text : "";

    return NextResponse.json({ reply }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("Chat API error:", err);
    return NextResponse.json({ error: "Failed to get a response. Try again." }, { status: 500, headers: CORS_HEADERS });
  }
}
