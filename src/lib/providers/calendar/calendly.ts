import type {
  CalendarProvider,
  TimeSlot,
  BookingRequest,
  BookingConfirmation,
} from "../types";

// ============================================================
// Calendly Calendar Provider (Swap-in alternative)
// ============================================================
// Note: Calendly's API does NOT support programmatic booking
// on free/standard plans. This provider uses scheduling links
// as a fallback and reads availability where possible.
//
// Set CALENDAR_PROVIDER=calendly in .env.local to activate.
// ============================================================

export class CalendlyProvider implements CalendarProvider {
  readonly id = "calendly";

  private get apiKey(): string {
    const key = process.env.CALENDLY_API_KEY;
    if (!key) throw new Error("CALENDLY_API_KEY is required (Standard plan+)");
    return key;
  }

  async getAvailableSlots(startDate: string, endDate: string): Promise<TimeSlot[]> {
    // Calendly doesn't expose raw slots via API on most plans
    // Fetch scheduled events to infer busy times
    const res = await fetch(
      `https://api.calendly.com/scheduled_events?min_start_time=${startDate}&max_start_time=${endDate}&status=active`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }
    );

    if (!res.ok) {
      throw new Error(`Calendly API error: ${await res.text()}`);
    }

    // Return empty -- Calendly doesn't give us raw availability
    // The voice/chat agent should provide the Calendly link instead
    console.warn(
      "Calendly does not support programmatic slot fetching. " +
      "Consider switching to Cal.com (CALENDAR_PROVIDER=calcom)"
    );
    return [];
  }

  async createBooking(_request: BookingRequest): Promise<BookingConfirmation> {
    // Calendly does NOT support programmatic booking creation
    // Return the scheduling link for the user to book manually
    const schedulingUrl = process.env.CALENDLY_EVENT_URI || "https://calendly.com";
    throw new Error(
      `Calendly does not support programmatic booking. ` +
      `Please share this link with the caller: ${schedulingUrl}. ` +
      `Consider switching to Cal.com for full API booking support.`
    );
  }

  async cancelBooking(bookingId: string): Promise<{ success: boolean }> {
    const res = await fetch(
      `https://api.calendly.com/scheduled_events/${bookingId}/cancellation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Cancelled via AI persona" }),
      }
    );
    return { success: res.ok };
  }

  async getBooking(bookingId: string): Promise<BookingConfirmation | null> {
    const res = await fetch(
      `https://api.calendly.com/scheduled_events/${bookingId}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }
    );

    if (!res.ok) return null;
    const data = await res.json();

    return {
      id: bookingId,
      status: data.resource?.status === "active" ? "confirmed" : "pending",
      startTime: data.resource?.start_time,
      endTime: data.resource?.end_time,
      meetingUrl: data.resource?.location?.join_url,
      attendeeName: "",
      attendeeEmail: "",
    };
  }
}
