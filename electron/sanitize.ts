/**
 * PII redaction for captured response bodies.
 *
 * Network capture is ALWAYS ON (no opt-in), so this is the sole guard standing
 * between a real dev-server response and anything that crosses IPC or persists
 * to `state.json`. `recordCapture` (mockCapture.ts) sanitizes at the moment of
 * recording, so every downstream consumer (the live inventory push, the diff
 * pre-flight, `captures:get`) sees only sanitized bodies.
 *
 * Heuristic, intentionally over-redacting: a key named `author` matches the
 * `auth` rule. Acceptable — the mock keeps its shape; realism loses to safety.
 *
 * Electron-free so the pure-Node integration scripts can drive it directly.
 */

const SENSITIVE_KEYS = /email|phone|token|password|secret|ssn|card|auth|cookie/i;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;

function redactString(value: string): string {
  return value.replace(EMAIL_RE, '[REDACTED_EMAIL]').replace(PHONE_RE, '[REDACTED_PHONE]');
}

/**
 * Returns a deep copy with sensitive-keyed values and email/phone patterns
 * redacted. Handles any JSON value: objects, top-level arrays, and primitives.
 */
export function sanitizeBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map((item) => sanitizeBody(item));
  if (body && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(key)) {
        // Redact the leaf; recurse into nested objects/arrays so structure
        // survives but any inner PII is still scrubbed.
        out[key] = value && typeof value === 'object' ? sanitizeBody(value) : '[REDACTED]';
      } else {
        out[key] = sanitizeBody(value);
      }
    }
    return out;
  }
  if (typeof body === 'string') return redactString(body);
  return body;
}
