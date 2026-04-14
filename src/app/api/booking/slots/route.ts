import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkAvailability } from "@/lib/booking/service";

// ============================================================
// Booking Slots API Route
// ============================================================
// GET /api/booking/slots?startDate=...&endDate=...
// Returns available time slots from the configured calendar.
//
// Security:
//  - Rate limiting handled by middleware (30 req/min)
//  - Query param validation via Zod
//  - Safe error responses
// ============================================================

const querySchema = z.object({
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const parsed = querySchema.safeParse({
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query parameters" },
        { status: 400 }
      );
    }

    const slots = await checkAvailability({
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
    });

    return NextResponse.json({
      slots,
      count: slots.length,
    });
  } catch (error) {
    console.error("[Booking Slots] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch available slots" },
      { status: 500 }
    );
  }
}
