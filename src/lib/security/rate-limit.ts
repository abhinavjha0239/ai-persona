// ============================================================
// In-Memory Rate Limiter (Sliding Window)
// ============================================================
// Lightweight rate limiter for API routes. Uses a sliding
// window counter keyed by IP address.
//
// For multi-instance deployments, swap this with Redis-backed
// rate limiting (e.g. @upstash/ratelimit). This is sufficient
// for single-instance / Vercel serverless deployments.
// ============================================================

interface WindowEntry {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowEntry>();

// Periodic cleanup to prevent unbounded memory growth
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) {
      windows.delete(key);
    }
  }
}

interface RateLimitConfig {
  /** Max requests in the window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check rate limit for a given key (typically IP address).
 * Returns whether the request is allowed and remaining quota.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  cleanup();

  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;
  const entry = windows.get(key);

  // No existing window — create one
  if (!entry || now >= entry.resetAt) {
    const resetAt = now + windowMs;
    windows.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: config.limit - 1, resetAt };
  }

  // Within existing window
  if (entry.count >= config.limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: config.limit - entry.count,
    resetAt: entry.resetAt,
  };
}

/**
 * Extract client IP from request headers.
 * Handles Vercel, Cloudflare, and standard proxy headers.
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

// Pre-configured limiters for different route types
export const RATE_LIMITS = {
  webhook: { limit: 60, windowSeconds: 60 },     // 60 req/min — voice platforms fire rapidly
  booking: { limit: 10, windowSeconds: 60 },      // 10 req/min — prevent spam bookings
  slots: { limit: 30, windowSeconds: 60 },         // 30 req/min — availability checks
  token: { limit: 20, windowSeconds: 60 },         // 20 req/min — token fetches
} as const;
