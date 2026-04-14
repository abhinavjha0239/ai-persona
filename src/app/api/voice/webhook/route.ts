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

const checkAvailabilityArgsSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

const createBookingArgsSchema = z.object({
  startTime: z.string().min(1),
  attendeeName: z.string().min(1).max(200),
  attendeeEmail: z.string().email().max(254),
  attendeeTimezone: z.string().max(50).optional(),
  notes: z.string().max(500).optional(),
});

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

    // Verify webhook signature
    const signature = getSignatureFromHeaders(req.headers);
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
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
}

interface ToolResult {
  toolCallId: string;
  response: string;
}

async function handleToolCall(toolCall: ToolCall): Promise<ToolResult> {
  const name = toolCall.name || toolCall.function?.name || "";
  const rawArgs = toolCall.arguments || toolCall.function?.arguments || "{}";
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
  if (!parsed.success) {
    return {
      toolCallId,
      response: "I need both a start date and end date to check availability. Could you specify the date range?",
    };
  }

  const slots = await checkAvailability({
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
  });
  const spoken = formatSlotsForVoice(slots, 4);
  return { toolCallId, response: spoken };
}

async function handleCreateBooking(
  toolCallId: string,
  raw: Record<string, unknown>
): Promise<ToolResult> {
  const parsed = createBookingArgsSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    return {
      toolCallId,
      response: `I need a few more details to book the meeting: ${missing}. Could you provide those?`,
    };
  }

  const booking = await createBooking({
    startTime: parsed.data.startTime,
    attendeeName: sanitizeName(parsed.data.attendeeName),
    attendeeEmail: sanitizeEmail(parsed.data.attendeeEmail),
    attendeeTimezone: parsed.data.attendeeTimezone,
    notes: parsed.data.notes ? sanitizeText(parsed.data.notes) : undefined,
  });

  const date = new Date(booking.startTime);
  const formattedDate = date.toLocaleDateString("en-IN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const formattedTime = date.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
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
}
