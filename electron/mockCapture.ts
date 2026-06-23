/**
 * In-memory buffer of real API response bodies captured at runtime by the
 * injected network interceptor (electron/inject/captureInterceptor.ts). These
 * become realistic mock bodies, replacing the synthetic {id,status} fallbacks.
 *
 * Keyed by canonical `METHOD:path` with concrete dynamic segments collapsed to
 * `:id` via the SAME `collapseDynamicSegments` the sidecar proxy uses for
 * discovery — so a captured body attaches to the discovered/scanned endpoint of
 * the same key.
 *
 * Bodies are sanitized at the moment of recording (capture is always-on, so this
 * is the earliest point to scrub PII before it reaches the bus / IPC / disk).
 *
 * Electron-free so the pure-Node integration scripts can drive it directly
 * (mirrors serverLogs.ts). The Electron-coupled report sink lives in
 * captureSink.ts.
 */
import { EventEmitter } from 'node:events';
import {
  canonicalOverrideKey,
  collapseDynamicSegments,
  type EndpointOverrides,
  type MockBody,
} from './overrideMatcher.js';
import { buildObservedEndpoint } from './endpointScanner.js';
import { sanitizeBody } from './sanitize.js';

const captured = new Map<string, MockBody>();

/** Emits `('endpoint', EndpointDefinition)` when a NEW endpoint is first captured. */
export const captureBus = new EventEmitter();

function isJsonContentType(contentType: string): boolean {
  return /\bjson\b/i.test(contentType);
}

/**
 * Record a captured response. Gated on a 2xx JSON object/array body (primitives
 * and error responses are not useful mocks). The body is sanitized before it is
 * stored; the first capture of a key emits a runtime endpoint carrying the real
 * body as its mock so the renderer inventory picks it up.
 */
export function recordCapture(
  method: string,
  pathname: string,
  status: number,
  contentType: string,
  body: MockBody,
): void {
  if (status < 200 || status >= 300) return;
  if (!isJsonContentType(contentType)) return;
  // Only structured bodies make useful mocks (objects and top-level arrays).
  if (!body || typeof body !== 'object') return;

  const routePath = collapseDynamicSegments(pathname);
  const key = canonicalOverrideKey(method, routePath);
  const sanitized = sanitizeBody(body);
  const isNew = !captured.has(key);
  // Always keep the freshest body (so the diff pre-flight / next push uses it);
  // announce a new inventory row only the first time we see the key.
  captured.set(key, sanitized);
  if (isNew) {
    captureBus.emit('endpoint', buildObservedEndpoint(method, routePath, sanitized));
  }
}

/** The current capture set as an override map (`METHOD:path` → body). */
export function getCaptures(): EndpointOverrides {
  return Object.fromEntries(captured);
}

export function clearCaptures(): void {
  captured.clear();
}

export function captureCount(): number {
  return captured.size;
}
