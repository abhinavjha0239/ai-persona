import { NextRequest, NextResponse } from "next/server";
import { getVoiceProvider } from "@/lib/providers/registry";

// ============================================================
// Voice Token API Route
// ============================================================
// Returns a token/config for the client-side voice SDK.
// The frontend calls this to initialize the voice widget.
//
// Security:
//  - Rate limiting handled by middleware
//  - Only returns the public key (safe for client exposure)
//  - Origin check in production to prevent cross-site abuse
// ============================================================

export async function GET(req: NextRequest) {
  try {
    // In production, verify the request comes from our own origin
    if (process.env.NODE_ENV === "production") {
      const origin = req.headers.get("origin") || req.headers.get("referer") || "";
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
      if (appUrl && !origin.startsWith(appUrl)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const voice = await getVoiceProvider();
    const token = await voice.getWebToken();
    const phoneNumber = await voice.getPhoneNumber();

    return NextResponse.json({
      token,
      assistantId: process.env.VAPI_ASSISTANT_ID || null,
      phoneNumber,
      provider: voice.id,
    });
  } catch (error) {
    console.error("[Voice Token] Error:", error);
    return NextResponse.json(
      { error: "Failed to initialize voice" },
      { status: 500 }
    );
  }
}
