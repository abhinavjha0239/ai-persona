import type { ToolDefinition } from "@/lib/providers/types";

// ============================================================
// Persona Configuration
// ============================================================
// Central config for the AI persona. Tool definitions are
// shared between voice and chat agents — define once, use
// everywhere.
// ============================================================

/**
 * Tool definitions used by both voice and chat agents.
 * These are the "function calls" the AI can make during conversation.
 */
export const personaTools: ToolDefinition[] = [
  {
    name: "check_availability",
    description:
      "Check available meeting slots for scheduling an interview or call. " +
      "Call this when the user wants to book a meeting or asks about availability.",
    parameters: {
      startDate: {
        type: "string",
        description: "Start date for availability check in ISO 8601 format (e.g., 2026-04-14T00:00:00Z). Default to tomorrow if not specified.",
      },
      endDate: {
        type: "string",
        description: "End date for availability check in ISO 8601 format (e.g., 2026-04-18T23:59:59Z). Default to 5 days from start if not specified.",
      },
    },
    required: ["startDate", "endDate"],
  },
  {
    name: "create_booking",
    description:
      "Book a meeting at a specific time. Only call this AFTER confirming the time slot, " +
      "attendee name, and email with the caller/user.",
    parameters: {
      startTime: {
        type: "string",
        description: "The selected time slot start in ISO 8601 format",
      },
      attendeeName: {
        type: "string",
        description: "Full name of the person booking the meeting",
      },
      attendeeEmail: {
        type: "string",
        description: "Email address for sending the calendar invite",
      },
      attendeeTimezone: {
        type: "string",
        description: "Timezone of the attendee (e.g., Asia/Kolkata). Default to Asia/Kolkata if not specified.",
      },
      notes: {
        type: "string",
        description: "Optional notes or context for the meeting",
      },
    },
    required: ["startTime", "attendeeName", "attendeeEmail"],
  },
];

/**
 * Voice-specific configuration.
 */
export const voiceConfig = {
  maxCallDurationSeconds: 600,    // 10 minutes
  silenceTimeoutSeconds: 20,      // Shorter — 20s feels more natural
  interruptionSensitivity: 0.8,   // Higher = more sensitive to barge-in
  responsiveness: 0.55,           // Balance speed vs premature cutoff
  backgroundSound: "office" as const,  // Subtle ambient noise reduces awkward silence
  endCallPhrases: ["goodbye", "bye", "end call", "that's all", "alvida", "bye bye", "band karo"],
};

/**
 * Format time slots for voice (spoken) output.
 * Makes the AI read times naturally on a call.
 */
export function formatSlotsForVoice(
  slots: { start: string; end: string }[],
  maxSlots = 4
): string {
  if (slots.length === 0) {
    return "I don't have any available slots in that range. Would you like to check different dates?";
  }

  const formatted = slots.slice(0, maxSlots).map((slot) => {
    const date = new Date(slot.start);
    const day = date.toLocaleDateString("en-IN", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const time = date.toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${day} at ${time}`;
  });

  if (formatted.length === 1) return `I'm available on ${formatted[0]}.`;

  const last = formatted.pop();
  return `I'm available on ${formatted.join(", ")}, and ${last}.`;
}

/**
 * Format time slots for chat (written) output.
 * More structured than voice output.
 */
export function formatSlotsForChat(
  slots: { start: string; end: string }[],
  maxSlots = 6
): string {
  if (slots.length === 0) {
    return "No available slots in that range. Would you like to check different dates?";
  }

  const lines = slots.slice(0, maxSlots).map((slot) => {
    const date = new Date(slot.start);
    const day = date.toLocaleDateString("en-IN", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const time = date.toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `- **${day}** at ${time}`;
  });

  return `Here are my available slots:\n\n${lines.join("\n")}\n\nWhich one works for you?`;
}
