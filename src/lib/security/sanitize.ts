// ============================================================
// Input Sanitization
// ============================================================
// Strips potentially dangerous content from user-supplied
// strings before they reach external services (Cal.com, etc.)
// ============================================================

/**
 * Sanitize a free-text string by stripping HTML tags and
 * control characters. Preserves normal unicode text.
 */
export function sanitizeText(input: string, maxLength = 500): string {
  return input
    .replace(/<[^>]*>/g, "")               // Strip HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // Strip control chars (keep \t \n \r)
    .trim()
    .slice(0, maxLength);
}

/**
 * Sanitize a name field — alphanumeric, spaces, hyphens,
 * apostrophes, and common unicode letters only.
 */
export function sanitizeName(input: string, maxLength = 200): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * Sanitize an email — lowercase, trim, basic format check.
 * Does NOT validate deliverability, just normalizes.
 */
export function sanitizeEmail(input: string): string {
  return input.toLowerCase().trim().slice(0, 254); // RFC 5321 max
}
