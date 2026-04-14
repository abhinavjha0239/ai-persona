import { createHmac, timingSafeEqual } from "crypto";

// ============================================================
// Webhook Signature Verification
// ============================================================
// Validates incoming webhook payloads using HMAC-SHA256.
// Prevents unauthorized callers from triggering tool calls
// or spamming bookings through the webhook endpoint.
// ============================================================

const SIGNATURE_HEADER = "x-vapi-signature";
const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Verify a Vapi webhook signature.
 * Returns true if the payload is authentic, false otherwise.
 *
 * Vapi signs webhooks with HMAC-SHA256 using your server secret.
 * If no secret is configured, verification is skipped in dev
 * and rejected in production.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined
): boolean {
  // No secret configured — allow in dev, reject in prod
  if (!secret) {
    if (process.env.NODE_ENV === "production") return false;
    return true;
  }

  if (!signature) return false;

  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (sigBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(sigBuffer, expectedBuffer);
}

/**
 * Extract and validate the signature from request headers.
 * Supports both Vapi's header format and a generic fallback.
 */
export function getSignatureFromHeaders(
  headers: Headers
): string | null {
  return (
    headers.get(SIGNATURE_HEADER) ||
    headers.get("x-webhook-signature") ||
    null
  );
}

/**
 * Safely parse JSON without throwing.
 * Returns the parsed object or null if parsing fails.
 */
export function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check if a timestamp is within the acceptable tolerance window.
 * Prevents replay attacks with old webhook payloads.
 */
export function isTimestampValid(
  timestamp: string | number | undefined,
  toleranceSeconds = TIMESTAMP_TOLERANCE_SECONDS
): boolean {
  if (!timestamp) return true; // Skip if no timestamp provided
  const ts = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
  if (Number.isNaN(ts)) return true; // Skip if unparseable
  const diff = Math.abs(Date.now() - ts);
  return diff <= toleranceSeconds * 1000;
}
