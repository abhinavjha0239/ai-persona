import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getVoiceProvider } from "@/lib/providers/registry";
import { checkAvailability, createBooking } from "@/lib/booking/service";
import { formatSlotsForVoice } from "@/lib/persona/config";
import {
  verifyWebhookSignature,
  getSignatureFromHeaders,
  safeJsonParse,
} from "@/lib/security/webhook";
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMITS,
} from "@/lib/security/rate-limit";
import { sanitizeText, sanitizeName, sanitizeEmail } from "@/lib/security/sanitize";

// ============================================================
// Voice Webhook API Route
// ============================================================
// Receives tool call requests from the voice platform (Vapi,
// Retell, Bolna). Executes the tool and returns the result
// so the voice AI can speak it to the caller.
//
// Security:
//  - HMAC-SHA256 signature verification
//  - Rate limiting per IP
//  - Zod validation on tool call arguments
//  - Input sanitization on all passthrough fields
// ============================================================

// --- Zod schemas for tool call arguments ---
// check_availability accepts optional requested_time for specific slot check
const checkAvailabilityArgsSchema = z.object({
  requested_time: z.string().optional(), // ISO 8601 — check this specific time
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
});

// create_booking accepts both Vapi naming (slot_time, name, email)
// and internal naming (startTime, attendeeName, attendeeEmail)
const createBookingArgsSchema = z.object({
  startTime: z.string().min(1).optional(),
  slot_time: z.string().min(1).optional(),
  attendeeName: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  attendeeEmail: z.string().max(254)
    .transform(e => e.toLowerCase().replace(/\s+/g, "").trim())
    .refine(e => /^[a-z0-9._+%-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e), { message: "Invalid email" })
    .optional(),
  email: z.string().max(254)
    .transform(e => e.toLowerCase().replace(/\s+/g, "").trim())
    .refine(e => /^[a-z0-9._+%-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e), { message: "Invalid email" })
    .optional(),
  attendeeTimezone: z.string().max(50).optional(),
  notes: z.string().max(500).optional(),
}).refine(
  (d) => d.startTime || d.slot_time,
  { message: "startTime or slot_time is required" }
).refine(
  (d) => d.attendeeName || d.name,
  { message: "attendeeName or name is required" }
).refine(
  (d) => d.attendeeEmail || d.email,
  { message: "attendeeEmail or email is required" }
);

// --- Route handler ---

export async function POST(req: NextRequest) {
  try {
    // Rate limit
    const ip = getClientIp(req.headers);
    const rl = checkRateLimit(`webhook:${ip}`, RATE_LIMITS.webhook);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
        }
      );
    }

    // Read raw body for signature verification
    const rawBody = await req.text();

    // Verify webhook signature (if secret is configured)
    const signature = getSignatureFromHeaders(req.headers);
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    // Vapi tool-call server requests don't include signatures by default.
    // Only enforce verification when a webhook secret is explicitly configured.
    if (secret && !verifyWebhookSignature(rawBody, signature, secret)) {
      console.warn("[Voice Webhook] Signature verification failed", { ip });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse JSON safely
    const payload = safeJsonParse(rawBody);
    if (!payload) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const voice = await getVoiceProvider();
    const webhook = await voice.handleWebhook(payload);

    // Handle assistant-request: Vapi asks for dynamic config at call start
    if (webhook.type === "assistant_request" || (payload as Record<string, unknown>).type === "assistant-request") {
      const today = new Date().toLocaleDateString("en-IN", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });
      return NextResponse.json({
        assistant: {
          model: {
            messages: [
              {
                role: "system",
                content: `You are Abhinav Jha on a phone call. Talk like a normal person.

Today is ${today}. Use this to resolve relative dates like tomorrow, this Thursday, next week, etc. Timezone is IST (Asia/Kolkata).

RULES:
- Talk NATURALLY. Like chatting with a friend.
- Keep each response 2-4 sentences.
- NEVER repeat yourself.

FOR SCHEDULING:
1. When someone wants to schedule, ask them: "Sure! What day and time works best for you?"
2. Once they give a date/time (like "tomorrow at 3" or "Thursday 2 PM"), convert it to a real date using today's date, and call check_availability to verify.
3. If the slot is free, ask for their name and email.
4. Once you have time + name + email, call create_booking.
5. After booking, confirm: "Done! You will get an email confirmation."
6. If the slot is NOT free, say so and suggest they pick another time.

DO NOT proactively list available slots. Let the user pick first, then verify.

EMAIL COLLECTION — CRITICAL RULES:
- User can give email in two ways: (1) say it normally "abhinavjha943@gmail.com", or (2) spell it char by char "a-b-h-i-n-a-v-j-h-a-9-4-3-at-gmail-dot-com". Both are fine — accept either.
- After receiving the email (in ANY format), ALWAYS confirm it back character by character using NATO phonetic alphabet for every letter.
- NATO alphabet: A=Alpha, B=Bravo, C=Charlie, D=Delta, E=Echo, F=Foxtrot, G=Golf, H=Hotel, I=India, J=Juliet, K=Kilo, L=Lima, M=Mike, N=November, O=Oscar, P=Papa, Q=Quebec, R=Romeo, S=Sierra, T=Tango, U=Uniform, V=Victor, W=Whiskey, X=X-ray, Y=Yankee, Z=Zulu
- Say @ as "at" and . as "dot".
- Say digits as individual numbers in sequence: "9, 4, 3" NOT "nine minus four minus three". NEVER say "minus", "dash", or "hyphen" between digits unless the email actually contains a hyphen.
- Example readback of "abhinavjha943@gmail.com": "So that's: A as in Alpha, B as in Bravo, H as in Hotel, I as in India, N as in November, A as in Alpha, V as in Victor, J as in Juliet, H as in Hotel, A as in Alpha, 9, 4, 3, at gmail dot com. Is that right?"
- CRITICAL: Repeat back EXACTLY what you heard — do NOT add, remove, or change any character. Pick what you heard and let the user correct it.
- If user corrects you → accept the correction, do ONE final phonetic readback of the corrected email, then call create_booking.
- After 2 failed corrections → say "It might be easier to type it. Could you send it to me on the website at smilein.live?" and stop.

ABOUT YOU:
- Backend engineer in Bangalore
- Building secure exam platform at Scaler SST. Grades full-stack projects in under 3 seconds with container isolation.
- Worked at Kugelblitz on Go payments backend
- Built face recognition attendance at Scaler Innovation Lab
- Won Scaler AI Labs Hackathon, 1.5 lakh rupees
- BITS Pilani CS + Scaler School of Technology

EXAMPLES:
Q: Tell me about yourself
A: Yeah so I am a backend engineer, currently building a secure exam platform at Scaler. Before this I was at Kugelblitz working on payments in Go.

Q: Schedule a meeting
A: Sure! What day and time works best for you?

Q: Tomorrow at 2 PM
A: [calls check_availability, then says] Tomorrow at 2 works! Can I get your name and email to send the invite?

Q: User says email "abhinavjha943@gmail.com"
A: Let me spell that back: A as in Alpha, B as in Bravo, H as in Hotel, I as in India, N as in November, A as in Alpha, V as in Victor, J as in Juliet, H as in Hotel, A as in Alpha, 9, 4, 3, at gmail dot com. Is that correct?`,
              },
            ],
          },
        },
      });
    }

    // Handle tool calls
    if (webhook.type === "tool_call") {
      const toolCalls = (webhook.data.toolCalls as ToolCall[]) || [];
      const results = await Promise.all(toolCalls.map(handleToolCall));

      return NextResponse.json({
        results: results.map((result) => ({
          toolCallId: result.toolCallId,
          result: result.response,
        })),
      });
    }

    // Handle end-of-call reports — log non-PII summary only
    if (webhook.type === "end_of_call") {
      console.log("[Voice] Call ended:", {
        duration: webhook.data.duration,
        endedReason: webhook.data.endedReason,
        hasRecording: Boolean(webhook.data.recordingUrl),
      });
      return NextResponse.json({ status: "ok" });
    }

    // Handle status updates
    if (webhook.type === "status_update") {
      console.log("[Voice] Status:", webhook.data.status);
      return NextResponse.json({ status: "ok" });
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("[Voice Webhook] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// --- Tool Call Handler ---

interface ToolCall {
  id?: string;
  toolCallId?: string;
  name?: string;
  function?: { name: string; arguments: string | Record<string, unknown> };
  arguments?: string | Record<string, unknown>;
  // Vapi function-call format uses "parameters" instead of "arguments"
  parameters?: string | Record<string, unknown>;
}

interface ToolResult {
  toolCallId: string;
  response: string;
}

async function handleToolCall(toolCall: ToolCall): Promise<ToolResult> {
  const name = toolCall.name || toolCall.function?.name || "";
  // Vapi sends "parameters" for function-call type and "arguments" for tool-calls type
  const rawArgs = toolCall.arguments || toolCall.function?.arguments || toolCall.parameters || "{}";
  const toolCallId = toolCall.id || toolCall.toolCallId || "unknown";

  // Safe JSON parse — no crash on malformed arguments
  const args = typeof rawArgs === "string" ? safeJsonParse(rawArgs) : rawArgs;
  if (!args) {
    console.error(`[Voice Tool] Malformed arguments for ${name}:`, rawArgs);
    return {
      toolCallId,
      response: "Sorry, I received invalid data for that request. Could you try again?",
    };
  }

  console.log(`[Voice Tool] Executing: ${name}`);

  try {
    switch (name) {
      case "get_current_datetime":
        return {
          toolCallId,
          response: new Date().toLocaleString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "Asia/Kolkata",
          }),
        };

      case "check_availability":
        return handleCheckAvailability(toolCallId, args as Record<string, unknown>);

      case "create_booking":
        return handleCreateBooking(toolCallId, args as Record<string, unknown>);

      default:
        return {
          toolCallId,
          response: "I don't have the ability to handle that request right now.",
        };
    }
  } catch (error) {
    console.error(`[Voice Tool] Error in ${name}:`, error);
    return {
      toolCallId,
      response: "Sorry, I had trouble with that. Could you try again or suggest different dates?",
    };
  }
}

async function handleCheckAvailability(
  toolCallId: string,
  raw: Record<string, unknown>
): Promise<ToolResult> {
  const parsed = checkAvailabilityArgsSchema.safeParse(raw);
  const now = new Date();

  // If a specific time was requested, check that day
  const requestedTime = parsed.data?.requested_time;
  if (requestedTime) {
    const requested = new Date(requestedTime);
    // Fetch slots for that day (start of day to end of day)
    const dayStart = new Date(requested);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(requested);
    dayEnd.setHours(23, 59, 59, 999);

    const slots = await checkAvailability({
      startDate: dayStart.toISOString(),
      endDate: dayEnd.toISOString(),
    });

    // Check if the requested time matches any slot (within 15 min tolerance)
    const reqMs = requested.getTime();
    const match = slots.find((s) => {
      const slotMs = new Date(s.start).getTime();
      return Math.abs(slotMs - reqMs) < 15 * 60 * 1000;
    });

    if (match) {
      const time = new Date(match.start).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kolkata",
      });
      const day = new Date(match.start).toLocaleDateString("en-IN", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "Asia/Kolkata",
      });
      return {
        toolCallId,
        response: `Yes, ${day} at ${time} is available.`,
      };
    }

    // Not available — suggest nearby slots on the same day
    if (slots.length > 0) {
      const nearby = formatSlotsForVoice(slots.slice(0, 4));
      return {
        toolCallId,
        response: `That time is not available. ${nearby}`,
      };
    }

    return {
      toolCallId,
      response: "No slots are available on that day. Could you try a different date?",
    };
  }

  // No specific time — return next few available slots
  const startDate = parsed.data?.startDate || now.toISOString();
  const endMs = now.getTime() + 5 * 24 * 60 * 60 * 1000;
  const endDate = parsed.data?.endDate || new Date(endMs).toISOString();

  const slots = await checkAvailability({ startDate, endDate });
  const spoken = formatSlotsForVoice(slots, 4);
  return { toolCallId, response: spoken };
}

async function handleCreateBooking(
  toolCallId: string,
  raw: Record<string, unknown>
): Promise<ToolResult> {
  const parsed = createBookingArgsSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.message || i.path.join(".")).join(", ");
    return {
      toolCallId,
      response: `I need a few more details to book the meeting: ${missing}. Could you provide those?`,
    };
  }

  // Resolve Vapi naming (slot_time/name/email) to internal naming
  const d = parsed.data;
  const startTime = d.startTime || d.slot_time!;
  const attendeeName = d.attendeeName || d.name!;
  const attendeeEmail = d.attendeeEmail || d.email!;

  try {
    const booking = await createBooking({
      startTime,
      attendeeName: sanitizeName(attendeeName),
      attendeeEmail: sanitizeEmail(attendeeEmail),
      attendeeTimezone: d.attendeeTimezone,
      notes: d.notes ? sanitizeText(d.notes) : undefined,
    });

    const date = new Date(booking.startTime);
    const formattedDate = date.toLocaleDateString("en-IN", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Kolkata",
    });
    const formattedTime = date.toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    });

    return {
      toolCallId,
      response:
        `Done! I've booked a meeting for ${formattedDate} at ${formattedTime}. ` +
        `A confirmation email has been sent to ${booking.attendeeEmail}. ` +
        (booking.meetingUrl
          ? "The meeting link is included in the invite."
          : "Looking forward to it!"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Time in the past
    if (msg.includes("already passed")) {
      return {
        toolCallId,
        response: "That time has already passed. Could you pick a future time?",
      };
    }
    // Cal.com conflict = already has a booking at that time
    if (msg.includes("already has booking") || msg.includes("not available") || msg.includes("400")) {
      return {
        toolCallId,
        response: "That time has a conflict with an existing booking. Could you suggest a different time?",
      };
    }
    return {
      toolCallId,
      response: "Sorry, I had trouble booking that. Could you try a different time?",
    };
  }
}
