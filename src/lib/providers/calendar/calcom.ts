import type {
  CalendarProvider,
  TimeSlot,
  BookingRequest,
  BookingConfirmation,
} from "../types";
import { env } from "@/lib/config/env";

// ============================================================
// Cal.com Calendar Provider
// ============================================================
// Uses Cal.com API v2 for availability checking and booking.
// Free tier: unlimited bookings, full API, webhooks.
// ============================================================

export class CalComProvider implements CalendarProvider {
  readonly id = "calcom";

  private get apiKey(): string {
    if (!env.CALCOM_API_KEY) throw new Error("CALCOM_API_KEY is required");
    return env.CALCOM_API_KEY;
  }

  private get eventTypeId(): string {
    if (!env.CALCOM_EVENT_TYPE_ID) throw new Error("CALCOM_EVENT_TYPE_ID is required");
    return env.CALCOM_EVENT_TYPE_ID;
  }

  private get baseUrl(): string {
    return env.CALCOM_BASE_URL;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "cal-api-version": "2024-08-13",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cal.com API error (${res.status}): ${body}`);
    }

    return res.json();
  }

  async getAvailableSlots(startDate: string, endDate: string): Promise<TimeSlot[]> {
    const params = new URLSearchParams({
      startTime: startDate,
      endTime: endDate,
      eventTypeId: this.eventTypeId,
    });

    const data = await this.request<{
      status: string;
      data: { slots: Record<string, { time: string }[]> };
    }>(`/slots/available?${params}`);

    console.log(`[Cal.com] Fetched slots for ${startDate} to ${endDate}, eventTypeId=${this.eventTypeId}`);
    console.log(`[Cal.com] Response status: ${data.status}, slots keys: ${Object.keys(data.data?.slots || {}).length}`);

    // Flatten the date-keyed slots into a flat array
    const slots: TimeSlot[] = [];
    for (const [date, daySlots] of Object.entries(data.data?.slots || {})) {
      for (const slot of daySlots) {
        const start = new Date(slot.time);
        const end = new Date(start.getTime() + 15 * 60 * 1000); // 15min meeting
        slots.push({
          start: start.toISOString(),
          end: end.toISOString(),
        });
      }
    }

    console.log(`[Cal.com] Total slots: ${slots.length}`);
    return slots;
  }

  async createBooking(request: BookingRequest): Promise<BookingConfirmation> {
    // Cal.com v2 response uses "start"/"end" (not "startTime"/"endTime")
    const data = await this.request<{
      status: string;
      data: {
        id: number;
        uid: string;
        status: string;
        start?: string;
        end?: string;
        startTime?: string;
        endTime?: string;
        meetingUrl?: string;
        attendees: { name: string; email: string }[];
      };
    }>("/bookings", {
      method: "POST",
      body: JSON.stringify({
        eventTypeId: Number(this.eventTypeId),
        start: request.startTime,
        attendee: {
          name: request.attendeeName,
          email: request.attendeeEmail,
          timeZone: request.attendeeTimezone || "Asia/Kolkata",
        },
        metadata: {
          source: "ai-persona-voice-agent",
          notes: request.notes,
        },
      }),
    });

    console.log("[Cal.com] Booking response fields:", Object.keys(data.data));

    return {
      id: data.data.uid,
      status: data.data.status === "ACCEPTED" ? "confirmed" : "pending",
      startTime: data.data.start || data.data.startTime || request.startTime,
      endTime: data.data.end || data.data.endTime || "",
      meetingUrl: data.data.meetingUrl,
      attendeeName: request.attendeeName,
      attendeeEmail: request.attendeeEmail,
    };
  }

  async cancelBooking(bookingId: string): Promise<{ success: boolean }> {
    try {
      await this.request(`/bookings/${bookingId}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          cancellationReason: "Cancelled via AI persona",
        }),
      });
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  async getBooking(bookingId: string): Promise<BookingConfirmation | null> {
    try {
      const data = await this.request<{
        status: string;
        data: {
          id: number;
          uid: string;
          status: string;
          startTime: string;
          endTime: string;
          meetingUrl?: string;
          attendees: { name: string; email: string }[];
        };
      }>(`/bookings/${bookingId}`);

      const attendee = data.data.attendees?.[0];
      return {
        id: data.data.uid,
        status: data.data.status === "ACCEPTED" ? "confirmed" : "pending",
        startTime: data.data.startTime,
        endTime: data.data.endTime,
        meetingUrl: data.data.meetingUrl,
        attendeeName: attendee?.name || "",
        attendeeEmail: attendee?.email || "",
      };
    } catch {
      return null;
    }
  }
}
