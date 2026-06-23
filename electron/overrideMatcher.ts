/**
 * Standalone matcher for mock endpoint overrides at diff runtime.
 *
 * Intentionally has NO imports from ipcValidation.ts (IPC boundary rule from
 * CLAUDE.md) and NO imports from endpointScanner.ts — override keys arrive
 * pre-canonicalized as `METHOD:path`.
 */

/**
 * A captured/mocked response body. Any JSON value — objects, but also top-level
 * arrays (list endpoints) and primitives. Served verbatim via `JSON.stringify`.
 */
export type MockBody = unknown;

export type EndpointOverrides = Record<string, MockBody>;

/**
 * Returns the canonical override key for a given method + route path.
 * Matches the scanner's dedup key in endpointScanner.ts (method already
 * uppercase, path normalized with [param] → :param).
 */
export function canonicalOverrideKey(method: string, routePath: string): string {
  return `${method.toUpperCase()}:${routePath}`;
}

/**
 * Collapse concrete dynamic path segments (numeric ids, UUIDs, and slug-style
 * ids) to ":id" so list/detail navigation (`/users/1`, `/users/2`) yields a
 * single mockable key that also matches a ":param" override.
 *
 * SHARED so runtime discovery (sidecar proxy) and capture (mockCapture) derive
 * the IDENTICAL key for the same concrete path — otherwise captured bodies would
 * not attach to discovered endpoints.
 *
 * The slug rule (>8 chars containing a digit) catches non-numeric/non-UUID ids
 * (e.g. `prod_8f3k20a1`). It is a no-op when no such segment exists, and a fix
 * when one does. Caveat: a long static segment that happens to contain a digit
 * (e.g. `oauth2callback`) is over-collapsed — validated against the observed-
 * endpoint expectations in `test:sidecar-mocks`.
 */
export function collapseDynamicSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (seg.length > 8 && /\d/.test(seg) && /^[a-z0-9_-]+$/i.test(seg)) return ':id';
      return seg;
    })
    .join('/');
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
): MockBody | undefined {
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
