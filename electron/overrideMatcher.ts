/**
 * Standalone matcher for mock endpoint overrides at diff runtime.
 *
 * Intentionally has NO imports from ipcValidation.ts (IPC boundary rule from
 * CLAUDE.md) and NO imports from endpointScanner.ts — override keys arrive
 * pre-canonicalized as `METHOD:path`.
 */

export type EndpointOverrides = Record<string, Record<string, unknown>>;

/**
 * Returns the canonical override key for a given method + route path.
 * Matches the scanner's dedup key in endpointScanner.ts (method already
 * uppercase, path normalized with [param] → :param).
 */
export function canonicalOverrideKey(method: string, routePath: string): string {
  return `${method.toUpperCase()}:${routePath}`;
}

/**
 * Splits an override key like "GET:/api/products/:productId" into
 * [method, path].  Splits only on the FIRST ":" so path segments containing
 * ":" (e.g. ":param") are preserved intact.
 */
function splitKey(key: string): [string, string] {
  const idx = key.indexOf(':');
  if (idx === -1) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * Finds the mocked response body for a concrete runtime request, or returns
 * undefined if no override matches.
 *
 * Matching rules:
 *   1. Exact match wins first (a concrete route key beats a :param sibling).
 *   2. Dynamic-segment match: key path segments that start with ":" act as
 *      wildcards; all other segments must equal the corresponding request
 *      segment exactly.
 *   3. Segment counts must match (no prefix or suffix matching).
 *
 * @param overrides  Pre-canonicalized map from "METHOD:path" to body object.
 * @param method     HTTP method of the intercepted request (any case).
 * @param pathname   URL pathname of the intercepted request (e.g. "/api/x").
 */
export function matchOverride(
  overrides: EndpointOverrides,
  method: string,
  pathname: string,
): Record<string, unknown> | undefined {
  const m = method.toUpperCase();

  // 1. Exact match
  const exactKey = `${m}:${pathname}`;
  if (Object.prototype.hasOwnProperty.call(overrides, exactKey)) {
    return overrides[exactKey];
  }

  // 2. Dynamic-segment match
  const reqSegs = pathname.split('/');
  for (const key of Object.keys(overrides)) {
    const [keyMethod, keyPath] = splitKey(key);
    if (keyMethod !== m) continue;
    const keySegs = keyPath.split('/');
    if (keySegs.length !== reqSegs.length) continue;
    const matches = keySegs.every((seg, i) => seg.startsWith(':') || seg === reqSegs[i]);
    if (matches) return overrides[key];
  }

  return undefined;
}
