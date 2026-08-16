/**
 * Cookie and token values must never reach logs or stored samples.
 * Everything that logs request/response metadata goes through here first.
 */

const SENSITIVE_KEY = /(cookie|token|authorization|auth|session|sid|uid|deviceid|fingerprint|secret|password)/i;

export const REDACTED = '[redacted]';

/** Replaces the value of any sensitive-looking header, leaving names intact. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    safe[name] = SENSITIVE_KEY.test(name) ? REDACTED : value;
  }
  return safe;
}

/** Deep-redacts sensitive keys in an arbitrary object before logging it. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactObject(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** Strips query parameters that carry identifiers, keeping the path readable. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
