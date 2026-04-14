import { NextRequest, NextResponse } from "next/server";
import { createBooking } from "@/lib/booking/service";
import { z } from "zod";
import { sanitizeName, sanitizeEmail, sanitizeText } from "@/lib/security/sanitize";

// ============================================================
// Create Booking API Route
// ============================================================
// POST /api/booking/create
// Creates a real calendar booking via the configured provider.
//
// Security:
//  - Rate limiting handled by middleware (10 req/min)
//  - Zod validation + input sanitization
//  - Deduplication guard against rapid duplicate submissions
//  - Safe error messages — no internal details leaked
// ============================================================

const bookingSchema = z.object({
  startTime: z.string().min(1, "Start time is required"),
  attendeeName: z.string().min(1, "Attendee name is required").max(200),
  attendeeEmail: z.string().email("Valid email is required").max(254),
  attendeeTimezone: z.string().max(50).default("Asia/Kolkata"),
  notes: z.string().max(500).optional(),
});

// Simple in-memory dedup: tracks recent booking keys (startTime+email)
// Prevents double-bookings from rapid duplicate submissions
const recentBookings = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000; // 30 seconds

function isDuplicateBooking(startTime: string, email: string): boolean {
  const key = `${startTime}:${email.toLowerCase()}`;
  const existing = recentBookings.get(key);
  const now = Date.now();

  // Cleanup expired entries
  for (const [k, ts] of recentBookings) {
    if (now - ts > DEDUP_WINDOW_MS) recentBookings.delete(k);
  }

  if (existing && now - existing < DEDUP_WINDOW_MS) return true;

  recentBookings.set(key, now);
  return false;
}

// Known user-facing errors from the booking service
const SAFE_ERROR_MESSAGES = new Set([
  "Start time is required",
  "Attendee name is required",
  "Attendee email is required",
  "Invalid email address",
  "Cannot book a slot in the past",
]);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = bookingSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Dedup guard
    if (isDuplicateBooking(parsed.data.startTime, parsed.data.attendeeEmail)) {
      return NextResponse.json(
        { error: "A booking for this time slot was already submitted. Please wait a moment." },
        { status: 409 }
      );
    }

    // Sanitize inputs before passing to service
    const booking = await createBooking({
      startTime: parsed.data.startTime,
      attendeeName: sanitizeName(parsed.data.attendeeName),
      attendeeEmail: sanitizeEmail(parsed.data.attendeeEmail),
      attendeeTimezone: parsed.data.attendeeTimezone,
      notes: parsed.data.notes ? sanitizeText(parsed.data.notes) : undefined,
    });

    return NextResponse.json({
      success: true,
      booking,
    });
  } catch (error) {
    console.error("[Create Booking] Error:", error);

    // Only expose known safe messages — hide internal Cal.com / provider errors
    const rawMessage = error instanceof Error ? error.message : "";
    const message = SAFE_ERROR_MESSAGES.has(rawMessage)
      ? rawMessage
      : "Failed to create booking. Please try again.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
