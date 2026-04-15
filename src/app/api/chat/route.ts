import { NextRequest } from "next/server";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import type { UIMessage } from "ai";
import { getChatModel } from "@/lib/ai/model";
import { getChatSystemPrompt } from "@/lib/persona/prompts";
import { retrieveContext } from "@/lib/rag/retriever";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/security/rate-limit";
import { chatTools } from "@/lib/ai/chat-tools";

// ============================================================
// Chat API Route — Streaming + Real Tool Calling
// ============================================================
// POST /api/chat
//
// Flow:
//   1. Rate-limit by client IP
//   2. Build conversation-aware RAG query from recent turns
//   3. Retrieve grounding context from the vector store
//   4. Convert UIMessages → ModelMessages (preserves tool call
//      round-trips across turns)
//   5. streamText with real tool definitions + agentic loop
//
// The model has two tools:
//   - check_availability  → queries Cal.com for free slots
//   - create_booking      → confirms a meeting on the calendar
//
// stopWhen: stepCountIs(4) lets the model:
//   step 1 — call check_availability
//   step 2 — read slots, call create_booking (or respond)
//   step 3 — read booking result, compose final reply
//   step 4 — hard ceiling (safety)
// ============================================================

export async function POST(req: NextRequest) {
  // ── Rate limiting ──────────────────────────────────────────
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(`chat:${ip}`, RATE_LIMITS.chat);
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
      },
    });
  }

  try {
    const body = await req.json();
    const messages: { role: string; parts: { type: string; text?: string }[] }[] =
      body.messages ?? [];

    // ── Build conversation-aware RAG query ─────────────────────
    // Includes last 2 turns of context so "tell me more about that"
    // finds the right knowledge chunks.
    const getText = (m: { parts: { type: string; text?: string }[] }) =>
      m.parts?.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ") ?? "";

    const lastUserMsg = messages.findLast((m) => m.role === "user");
    const lastUserText = lastUserMsg ? getText(lastUserMsg) : "";

    let searchQuery = lastUserText;
    let boosted = false;

    // Query augmentation: boost retrieval for topic-specific questions.
    // Use full words OR word-start patterns (no trailing \b on prefixes).
    const lower = lastUserText.toLowerCase();
    const queryBoosts: [RegExp, string][] = [
      [/\b(education|study|studies|studied|student|degree|university|college|school|graduate|graduation|campus|btech|pilani|bits)\b/i,
        " education degree university BITS Pilani Scaler School of Technology Computer Science"],
      [/\b(work|experience|intern|internship|job|company|employ|career|background)\b/i,
        " work experience Kugelblitz Scaler Innovation Lab backend engineer"],
      [/\b(skill|skills|tech|stack|language|languages|framework|tool|tools|proficien)/i,
        " skills languages Go Python TypeScript Redis Docker"],
      [/\b(achieve|achievement|award|hackathon|prize|winner|accomplish)/i,
        " achievements hackathon winner prize Scaler AI Labs"],
    ];
    for (const [pattern, boost] of queryBoosts) {
      if (pattern.test(lower)) {
        searchQuery = lastUserText + boost;
        boosted = true;
        break;
      }
    }

    // Only add conversation context when the query is ambiguous AND no
    // topic boost matched. Boosted queries already have disambiguation
    // keywords — adding prior-turn context would dilute the signal.
    if (!boosted) {
      const isAmbiguous = lastUserText.split(" ").length < 6
        || /\b(that|it|this|more|same|those|them|there|above|previous)\b/i.test(lastUserText);
      if (messages.length > 1 && lastUserText.trim() && isAmbiguous) {
        const recentContext = messages
          .slice(-4)
          .map((m) => {
            const text = getText(m);
            return text.length > 200 ? text.slice(0, 200) : text;
          })
          .join(" | ");
        searchQuery = `${searchQuery} [context: ${recentContext}]`;
      }
    }

    // ── RAG retrieval (best-effort — non-fatal) ────────────────
    let knowledge = "";
    try {
      if (lastUserText.trim()) {
        const topK = /\b(education|study|studies|degree|experience|work|background|college|university)\b/i.test(lower) ? 8 : 6;
        const { context } = await retrieveContext(searchQuery, topK);
        knowledge = context;
      }
    } catch (err) {
      console.warn("[Chat] RAG retrieval failed, continuing without context:", err);
    }

    // ── System prompt ──────────────────────────────────────────
    const today = new Date().toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });

    const systemPrompt = getChatSystemPrompt({
      knowledge: knowledge || undefined,
      today,
    });

    // ── Convert UIMessages → ModelMessages ─────────────────────
    // Passing tools here lets the SDK correctly round-trip tool
    // call / tool result pairs from previous conversation turns.
    // The body is JSON-parsed so TypeScript can't verify the UIMessage
    // discriminated union — cast is safe because useChat sends this shape.
    const modelMessages = await convertToModelMessages(
      messages as unknown as Omit<UIMessage, "id">[],
      { tools: chatTools }
    );

    const model = await getChatModel();

    // ── Stream with real tool calling ──────────────────────────
    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools: chatTools,
      toolChoice: "auto",
      stopWhen: stepCountIs(4),
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error("[Chat] Error:", error);
    return new Response(JSON.stringify({ error: "Failed to generate response" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
