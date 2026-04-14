import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMITS,
} from "@/lib/security/rate-limit";

// ============================================================
// Next.js Middleware
// ============================================================
// Runs on every matched request before the route handler.
// Applies:
//  1. Security headers on all responses
//  2. Rate limiting on API routes
// ============================================================

// Map route prefixes to their rate limit configs
const ROUTE_RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  "/api/booking/create": RATE_LIMITS.booking,
  "/api/booking/slots": RATE_LIMITS.slots,
  "/api/voice/token": RATE_LIMITS.token,
  // Webhook has its own rate limiting inside the route handler
  // because it needs to read raw body for signature verification
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // --- Rate limiting for API routes ---
  for (const [prefix, config] of Object.entries(ROUTE_RATE_LIMITS)) {
    if (pathname.startsWith(prefix)) {
      const ip = getClientIp(req.headers);
      const rl = checkRateLimit(`${prefix}:${ip}`, config);

      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Too many requests" },
          {
            status: 429,
            headers: {
              "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
              ...securityHeaders(),
            },
          }
        );
      }
    }
  }

  // --- Security headers on all responses ---
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(securityHeaders())) {
    response.headers.set(key, value);
  }

  return response;
}

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  };
}

// Only run middleware on API routes and pages, skip static assets
export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|public/).*)",
  ],
};
