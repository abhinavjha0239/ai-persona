import { tool, zodSchema } from "ai";
import { z } from "zod";
import { checkAvailability, createBooking } from "@/lib/booking/service";
import { sanitizeName, sanitizeEmail } from "@/lib/security/sanitize";
import { formatSlotsForChat } from "@/lib/persona/config";

// ============================================================
// Chat AI Tools — Real AI SDK v6 Tool Definitions
// ============================================================
// AI SDK v6 uses inputSchema: zodSchema(z.object({...})) instead
// of the v5 parameters: z.object({...}).
//
// Backed by the booking service layer. Tool outputs are
// formatted as human-readable strings so the LLM can speak
// them naturally in its next response turn.
// ============================================================

const IST = "Asia/Kolkata";

// Define schemas separately so we can derive explicit arg types
const checkAvailabilitySchema = z.object({
  requestedTime: z
    .string()
    .optional()
    .describe(
      "ISO 8601 datetime the user asked for, e.g. '2026-04-16T16:00:00+05:30'. " +
      "When provided, checks if that exact slot is free and returns yes/no with alternatives if not. " +
      "Always provide this when the user has stated a specific preferred time."
    ),
  startDate: z
    .string()
    .optional()
    .describe(
      "ISO 8601 start of the search window. Defaults to now + 2 hours if omitted."
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      "ISO 8601 end of the search window. Defaults to 7 days from startDate if omitted."
    ),
});

const createBookingSchema = z.object({
  startTime: z
    .string()
    .describe(
      "ISO 8601 datetime with IST offset, e.g. '2026-04-22T15:00:00+05:30'. Must be a future time."
    ),
  attendeeName: z
    .string()
    .min(1)
    .max(200)
    .describe("Full name of the person booking the meeting."),
  attendeeEmail: z
    .string()
    .max(254)
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: "Must be a valid email address",
    })
    .describe("Email address where the calendar invite will be sent."),
});

type CheckAvailabilityArgs = z.infer<typeof checkAvailabilitySchema>;
type CreateBookingArgs = z.infer<typeof createBookingSchema>;

export const chatTools = {
  check_availability: tool({
    description:
      "Check Abhinav's available meeting slots. " +
      "Call this ONLY after the user has given a preferred day/time. " +
      "If the user just says they want to schedule, ask for their preferred time first — " +
      "do NOT call this tool until they specify a day or time.",
    inputSchema: zodSchema(checkAvailabilitySchema),
    execute: async (args: CheckAvailabilityArgs): Promise<string> => {
      const { requestedTime, startDate, endDate } = args;
      try {
        // When the user asked for a specific time, check that day and
        // confirm whether that exact slot is free (within 15 min tolerance).
        if (requestedTime) {
          const requested = new Date(requestedTime);
          const dayStart = new Date(requested);
          dayStart.setHours(0, 0, 0, 0);
          const dayEnd = new Date(requested);
          dayEnd.setHours(23, 59, 59, 999);

          const slots = await checkAvailability({
            startDate: dayStart.toISOString(),
            endDate: dayEnd.toISOString(),
          });

          const reqMs = requested.getTime();
          const TOLERANCE_MS = 15 * 60 * 1000;
          const match = slots.find(
            (s) => Math.abs(new Date(s.start).getTime() - reqMs) < TOLERANCE_MS
          );

          if (match) {
            const fmtDate = new Date(match.start).toLocaleDateString("en-IN", {
              weekday: "long", month: "long", day: "numeric", timeZone: IST,
            });
            const fmtTime = new Date(match.start).toLocaleTimeString("en-IN", {
              hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST,
            });
            return `Yes, ${fmtDate} at ${fmtTime} IST is available.`;
          }

          // Not free — show alternatives closest to the requested time, sorted chronologically
          if (slots.length > 0) {
            const byProximity = [...slots].sort(
              (a, b) =>
                Math.abs(new Date(a.start).getTime() - reqMs) -
                Math.abs(new Date(b.start).getTime() - reqMs)
            );
            // Take the 8 nearest, then sort them chronologically for display
            const nearest = byProximity.slice(0, 8).sort(
              (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
            );
            const nearby = formatSlotsForChat(nearest, 8);
            return `That exact time isn't available. Here are the closest open slots on that day:\n\n${nearby}`;
          }

          return "No slots are available on that day. Would you like to try a different date?";
        }

        // No specific time — return next available slots
        const slots = await checkAvailability({ startDate, endDate });
        if (slots.length === 0) {
          return (
            "No available slots found in that range. " +
            "The calendar may be fully booked — try asking about a different week."
          );
        }
        return formatSlotsForChat(slots);
      } catch (err) {
        console.error("[chat tool] check_availability failed:", err);
        return "Couldn't fetch availability right now. Please try again in a moment.";
      }
    },
  }),

  create_booking: tool({
    description:
      "Book a meeting with Abhinav at a specific confirmed time. " +
      "Only call this AFTER the user has explicitly confirmed the slot AND provided " +
      "both their name and email. Never call without all three.",
    inputSchema: zodSchema(createBookingSchema),
    execute: async (args: CreateBookingArgs): Promise<string> => {
      const { startTime, attendeeName, attendeeEmail } = args;
      try {
        const booking = await createBooking({
          startTime,
          attendeeName: sanitizeName(attendeeName),
          attendeeEmail: sanitizeEmail(attendeeEmail),
          attendeeTimezone: IST,
        });

        const date = new Date(booking.startTime);
        const fmtDate = date.toLocaleDateString("en-IN", {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: IST,
        });
        const fmtTime = date.toLocaleTimeString("en-IN", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: IST,
        });

        const lines = [
          `Booking confirmed!`,
          `📅 ${fmtDate} at ${fmtTime} IST`,
          `📧 Confirmation sent to ${booking.attendeeEmail}`,
        ];
        if (booking.meetingUrl) {
          lines.push(`🔗 Meeting link: ${booking.meetingUrl}`);
        }
        // Machine-readable suffix for rich UI card rendering
        const bookingMeta = [
          booking.startTime,
          booking.attendeeName,
          booking.attendeeEmail,
          booking.meetingUrl || "",
        ].join("|");
        lines.push(`[BOOKING|${bookingMeta}]`);
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes("already passed")) {
          return "That time has already passed. Please ask the user to pick a future slot.";
        }
        if (
          msg.includes("already has booking") ||
          msg.includes("not available") ||
          msg.includes("400")
        ) {
          return (
            "That slot already has a booking. " +
            "Please call check_availability again and offer the user a different time."
          );
        }

        console.error("[chat tool] create_booking failed:", err);
        return (
          "The booking failed due to a calendar error. " +
          "Ask the user to try a different time or reach out directly."
        );
      }
    },
  }),
} as const;

export type ChatTools = typeof chatTools;
