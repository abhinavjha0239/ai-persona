import { NextRequest } from "next/server";
import { streamText } from "ai";
import { getChatModel } from "@/lib/ai/model";
import { getChatSystemPrompt } from "@/lib/persona/prompts";
import { retrieveContext } from "@/lib/rag/retriever";
import { checkAvailability, createBooking } from "@/lib/booking/service";
import { formatSlotsForChat } from "@/lib/persona/config";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/security/rate-limit";
import { sanitizeName, sanitizeEmail, sanitizeText } from "@/lib/security/sanitize";

// ============================================================
// Chat API Route (Streaming)
// ============================================================
// POST /api/chat
// Accepts UI messages, retrieves RAG context, and streams
// a response using Vercel AI SDK v6 UIMessageStream protocol.
//
// Uses the configured LLM_PROVIDER (default: Azure OpenAI) + tool calling for booking.
// ============================================================


export async function POST(req: NextRequest) {
  // Rate limit
  const ip = getClientIp(req.headers);
  const rl = checkRateLimit(`chat:${ip}`, RATE_LIMITS.slots);
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
      body.messages || [];

    // Extract text from messages
    const getText = (m: { parts: { type: string; text?: string }[] }) =>
      m.parts?.filter((p) => p.type === "text").map((p) => p.text || "").join(" ") || "";

    const lastUserMsg = messages.findLast((m) => m.role === "user");
    const lastUserText = lastUserMsg ? getText(lastUserMsg) : "";

    // Build conversation-aware search query.
    // If the user says "tell me more about that" or "explain the security model",
    // we need recent conversation context to disambiguate.
    let searchQuery = lastUserText;
    if (messages.length > 1 && lastUserText.trim()) {
      const recentContext = messages
        .slice(-4) // last 2 turns (user+assistant pairs)
        .map((m) => {
          const text = getText(m);
          return text.length > 200 ? text.slice(0, 200) : text;
        })
        .join(" | ");
      // Combine: recent context gives topic, last message gives intent
      searchQuery = `${lastUserText} [context: ${recentContext}]`;
    }

    // RAG: retrieve relevant context using conversation-aware query
    let knowledge = "";
    try {
      if (lastUserText.trim()) {
        const { context } = await retrieveContext(searchQuery, 6);
        knowledge = context;
      }
    } catch (err) {
      console.warn("[Chat] RAG retrieval failed, continuing without context:", err);
    }

    const systemPrompt = getChatSystemPrompt({ knowledge: knowledge || undefined });

    // Convert UIMessage parts to model messages
    const modelMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text || "")
          .join("\n") || "",
      }));

    const model = await getChatModel();

    // Detect scheduling intent and pre-fetch slots
    const isScheduling = /schedul|book|call|meet|interview|availab/i.test(lastUserText);
    let bookingContext = "";
    if (isScheduling) {
      try {
        const slots = await checkAvailability({});
        bookingContext = `\n\n<available_slots>\n${formatSlotsForChat(slots, 8)}\n</available_slots>\n\nIMPORTANT: The user wants to schedule. Show them the available slots above and ask which one works. Also ask for their name and email to confirm the booking.`;
      } catch (err) {
        console.warn("[Chat] Failed to fetch slots:", err);
      }
    }

    // Detect booking confirmation — user provided time + name + email in conversation
    let bookingResult = "";
    const allText = modelMessages.map(m => m.content).join("\n").toLowerCase();
    const hasSlotContext = allText.includes("9:") || allText.includes("10:") || allText.includes("11:") || allText.includes("available slots");
    const hasEmail = allText.match(/[\w.-]+@[\w.-]+\.\w+/);
    const hasTimeConfirm = lastUserText.match(/\b(\d{1,2}:\d{2})\b/);

    if (hasSlotContext && hasEmail && hasTimeConfirm) {
      try {
        // Extract booking details from conversation
        const email = allText.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0] || "";
        const time = lastUserText.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        // Find the name — look for text before the email
        const nameMatch = allText.match(/(?:name|i'm|i am|this is)\s+([a-z ]{2,30})/i) || allText.match(/^([a-z ]{2,30})\s*(?:email|@)/im);
        const name = nameMatch?.[1]?.trim() || "Guest";

        // Find matching slot from Cal.com
        const slots = await checkAvailability({});
        const targetHour = parseInt(time.split(":")[0]);
        const targetMin = parseInt(time.split(":")[1]);
        const matchingSlot = slots.find(s => {
          const d = new Date(s.start);
          const slotHour = d.getHours() || d.getUTCHours() + 5; // IST offset
          const slotMin = d.getMinutes() || d.getUTCMinutes() + 30;
          return Math.abs(((slotHour * 60 + slotMin) % (24*60)) - (targetHour * 60 + targetMin)) < 30;
        });

        if (matchingSlot && email) {
          const booking = await createBooking({
            startTime: matchingSlot.start,
            attendeeName: sanitizeName(name),
            attendeeEmail: sanitizeEmail(email),
          });
          const date = new Date(booking.startTime);
          bookingResult = `\n\n<booking_confirmed>\nBooking confirmed! ${date.toLocaleDateString("en-IN", { weekday: "long", month: "long", day: "numeric" })} at ${date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })}. Confirmation sent to ${booking.attendeeEmail}.${booking.meetingUrl ? ` Meeting link: ${booking.meetingUrl}` : ""}\n</booking_confirmed>\n\nIMPORTANT: Tell the user their booking is confirmed with the details above. Be enthusiastic!`;
        }
      } catch (err) {
        console.warn("[Chat] Booking failed:", err);
      }
    }

    const finalSystem = systemPrompt + bookingContext + bookingResult;

    const result = streamText({
      model,
      system: finalSystem,
      messages: modelMessages,
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
