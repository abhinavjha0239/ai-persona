import type {
  CalendarProvider,
  TimeSlot,
  BookingRequest,
  BookingConfirmation,
} from "../types";

// ============================================================
// Google Calendar Provider (Direct API)
// ============================================================
// Uses Google Calendar API directly for full control.
// Requires OAuth2 setup (one-time for your own calendar).
//
// Set CALENDAR_PROVIDER=google in .env.local to activate.
// ============================================================

export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = "google";

  private async getAccessToken(): Promise<string> {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Google Calendar requires GOOGLE_CALENDAR_CLIENT_ID, " +
        "GOOGLE_CALENDAR_CLIENT_SECRET, and GOOGLE_CALENDAR_REFRESH_TOKEN"
      );
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) throw new Error(`Google OAuth error: ${await res.text()}`);
    const data = await res.json();
    return data.access_token;
  }

  async getAvailableSlots(startDate: string, endDate: string): Promise<TimeSlot[]> {
    const accessToken = await this.getAccessToken();

    // Use FreeBusy API to get busy intervals
    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin: startDate,
          timeMax: endDate,
          items: [{ id: "primary" }],
        }),
      }
    );

    if (!res.ok) throw new Error(`Google Calendar error: ${await res.text()}`);
    const data = await res.json();

    const busySlots = data.calendars?.primary?.busy || [];

    // Generate 30-min slots during working hours (9 AM - 6 PM IST)
    const slots: TimeSlot[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0 || d.getDay() === 6) continue; // Skip weekends

      for (let hour = 9; hour < 18; hour++) {
        for (const minute of [0, 30]) {
          const slotStart = new Date(d);
          slotStart.setHours(hour, minute, 0, 0);
          const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);

          // Check if slot conflicts with busy times
          const isBusy = busySlots.some((busy: { start: string; end: string }) => {
            const busyStart = new Date(busy.start);
            const busyEnd = new Date(busy.end);
            return slotStart < busyEnd && slotEnd > busyStart;
          });

          if (!isBusy && slotStart > new Date()) {
            slots.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
            });
          }
        }
      }
    }

    return slots;
  }

  async createBooking(request: BookingRequest): Promise<BookingConfirmation> {
    const accessToken = await this.getAccessToken();

    const endTime = new Date(
      new Date(request.startTime).getTime() + 30 * 60 * 1000
    ).toISOString();

    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: `Interview with ${request.attendeeName}`,
          description: `Booked via AI Persona\n${request.notes || ""}`,
          start: { dateTime: request.startTime, timeZone: request.attendeeTimezone || "Asia/Kolkata" },
          end: { dateTime: endTime, timeZone: request.attendeeTimezone || "Asia/Kolkata" },
          attendees: [{ email: request.attendeeEmail }],
          conferenceData: {
            createRequest: { requestId: `ai-persona-${Date.now()}` },
          },
        }),
      }
    );

    if (!res.ok) throw new Error(`Google Calendar booking error: ${await res.text()}`);
    const data = await res.json();

    return {
      id: data.id,
      status: "confirmed",
      startTime: data.start.dateTime,
      endTime: data.end.dateTime,
      meetingUrl: data.hangoutLink,
      attendeeName: request.attendeeName,
      attendeeEmail: request.attendeeEmail,
    };
  }

  async cancelBooking(bookingId: string): Promise<{ success: boolean }> {
    try {
      const accessToken = await this.getAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${bookingId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      return { success: res.ok };
    } catch {
      return { success: false };
    }
  }

  async getBooking(bookingId: string): Promise<BookingConfirmation | null> {
    try {
      const accessToken = await this.getAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${bookingId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!res.ok) return null;
      const data = await res.json();

      return {
        id: data.id,
        status: "confirmed",
        startTime: data.start.dateTime,
        endTime: data.end.dateTime,
        meetingUrl: data.hangoutLink,
        attendeeName: data.attendees?.[0]?.email || "",
        attendeeEmail: data.attendees?.[0]?.email || "",
      };
    } catch {
      return null;
    }
  }
}
