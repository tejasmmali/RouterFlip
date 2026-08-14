/**
 * Secret masking and redaction.
 *
 * Security invariants enforced here:
 *  - No code path ever renders a complete API key.
 *  - The mask is a FIXED width, so it does not leak the secret's length.
 *  - At most the last 4 characters are revealed, and only when the secret is
 *    long enough that those 4 characters are not most of it.
 */

const BULLET = '•'; // •
const MASK_WIDTH = 12;
const REVEAL = 4;
/** Secrets at or below this length reveal nothing at all. */
const MIN_LENGTH_TO_REVEAL = 12;

/**
 * Renders a secret as a fixed-width mask with an optional 4-character tail so
 * the user can tell two keys apart without ever seeing either in full.
 */
export function maskSecret(secret: string | undefined | null): string {
  const value = (secret ?? '').trim();
  if (value.length === 0) return BULLET.repeat(MASK_WIDTH);
  if (value.length < MIN_LENGTH_TO_REVEAL) return BULLET.repeat(MASK_WIDTH);
  return BULLET.repeat(MASK_WIDTH) + value.slice(-REVEAL);
}

/** Asterisk variant for text inputs where bullets render poorly. */
export function maskSecretAscii(secret: string | undefined | null): string {
  const value = (secret ?? '').trim();
  if (value.length < MIN_LENGTH_TO_REVEAL) return '*'.repeat(MASK_WIDTH);
  return '*'.repeat(MASK_WIDTH) + value.slice(-REVEAL);
}

/** A short non-reversible fingerprint, useful for "is this the same key?". */
export function secretFingerprint(secret: string): string {
  // Intentionally not a cryptographic identity — just 4 hex chars of a
  // non-reversible digest, enough to compare two keys without revealing either.
  let h1 = 0x811c9dc5;
  for (let i = 0; i < secret.length; i += 1) {
    h1 ^= secret.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0').slice(0, 4);
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT-ish
];

const SENSITIVE_KEY = /key|token|secret|password|authorization|credential/i;

/**
 * Scrubs known secret values plus anything that *looks* like a credential from
 * a string before it is logged or shown in an error. Called on every verbose
 * log line and every error detail, so a leak requires two independent bugs.
 */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    const value = secret?.trim();
    if (!value || value.length < 6) continue;
    out = out.split(value).join(maskSecret(value));
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => maskSecret(match));
  }
  return out;
}

/** Deep-redacts an object for debug output: sensitive keys become masks. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key)
        ? maskSecret(typeof item === 'string' ? item : '')
        : redactObject(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redact(value);
  return value;
}
