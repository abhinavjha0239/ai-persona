import { getCalendarProvider } from "@/lib/providers/registry";
import type { BookingConfirmation, TimeSlot } from "@/lib/providers/types";

// ============================================================
// Booking Service — Business Logic
// ============================================================
// Thin orchestration layer over the calendar provider.
// Handles defaults, validation, and formatting.
// Provider-agnostic: works with Cal.com, Calendly, or Google.
// ============================================================

export interface CheckAvailabilityInput {
  startDate?: string;
  endDate?: string;
}

export interface CreateBookingInput {
  startTime: string;
  attendeeName: string;
  attendeeEmail: string;
  attendeeTimezone?: string;
  notes?: string;
}

/**
 * Check available time slots.
 * Defaults to next 5 business days if no dates specified.
 */
export async function checkAvailability(
  input: CheckAvailabilityInput
): Promise<TimeSlot[]> {
  const calendar = await getCalendarProvider();

  const now = new Date();
  // Always start from at least 2 hours from now to avoid past-slot issues
  const minStart = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const requestedStart = input.startDate ? new Date(input.startDate) : null;
  const effectiveStart = requestedStart && requestedStart > minStart ? requestedStart : minStart;

  const startDate = effectiveStart.toISOString();
  const endDate =
    input.endDate ||
    new Date(effectiveStart.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Always force endDate to be startDate + 7 days (LLM sometimes sends bad dates)
  const safeEndDate = new Date(new Date(startDate).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const finalEndDate = endDate && new Date(endDate) > new Date(startDate) ? endDate : safeEndDate;

  console.log(`[Booking] Checking slots: ${startDate} to ${finalEndDate}`);
  const slots = await calendar.getAvailableSlots(startDate, finalEndDate);
  console.log(`[Booking] Calendar returned: ${slots.length} slots`);

  // Filter out past slots
  const futureSlots = slots.filter(
    (slot) => new Date(slot.start) > new Date()
  );
  console.log(`[Booking] After future filter: ${futureSlots.length} slots`);

  return futureSlots;
}

/**
 * Create a booking.
 * Validates inputs before calling the calendar provider.
 */
export async function createBooking(
  input: CreateBookingInput
): Promise<BookingConfirmation> {
  // Validate required fields
  if (!input.startTime) throw new Error("Start time is required");
  if (!input.attendeeName) throw new Error("Attendee name is required");
  if (!input.attendeeEmail) throw new Error("Attendee email is required");

  // Basic email validation
  if (!input.attendeeEmail.includes("@")) {
    throw new Error("Invalid email address");
  }

  // Don't allow booking in the past (checks both date AND time)
  if (new Date(input.startTime) < new Date()) {
    throw new Error("That time has already passed. Please pick a future time.");
  }

  const calendar = await getCalendarProvider();

  return calendar.createBooking({
    startTime: input.startTime,
    attendeeName: input.attendeeName,
    attendeeEmail: input.attendeeEmail,
    attendeeTimezone: input.attendeeTimezone || "Asia/Kolkata",
    notes: input.notes,
  });
}

/**
 * Cancel a booking by ID.
 */
export async function cancelBooking(bookingId: string): Promise<{ success: boolean }> {
  const calendar = await getCalendarProvider();
  return calendar.cancelBooking(bookingId);
}
