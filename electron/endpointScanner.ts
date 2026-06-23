import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { EndpointDefinition, EndpointField } from './types.js';
import type { MockBody } from './overrideMatcher.js';

const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
]);

const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json']);
const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

async function walkFiles(root: string, files: string[] = []) {
  const entries = await fs.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walkFiles(path.join(root, entry.name), files);
      }
      continue;
    }

    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.join(root, entry.name));
    }
  }

  return files;
}

function normalizeRoutePath(value: string) {
  if (!value.startsWith('/')) return `/${value}`;
  return value;
}

function nextRouteFromFile(repoPath: string, filePath: string) {
  const relativePath = path.relative(repoPath, filePath).replaceAll(path.sep, '/');

  if (relativePath.startsWith('pages/api/')) {
    const route = relativePath
      .replace(/^pages\/api/, '/api')
      .replace(/\.(tsx?|jsx?|mjs|cjs)$/, '')
      .replace(/\/index$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');
    return normalizeRoutePath(route);
  }

  const appApiMatch = relativePath.match(/^app\/api\/(.+)\/route\.(tsx?|jsx?|mjs|cjs)$/);
  if (appApiMatch) {
    return normalizeRoutePath(`/api/${appApiMatch[1].replace(/\[([^\]]+)\]/g, ':$1')}`);
  }

  return undefined;
}

function detectType(rawValue: string): EndpointField['type'] {
  const value = rawValue.trim();
  if (/^["'`]/.test(value)) return 'string';
  if (/^\d+(\.\d+)?/.test(value)) return 'number';
  if (/^(true|false)\b/.test(value)) return 'boolean';
  if (/^\[/.test(value)) return 'array';
  if (/^\{/.test(value)) return 'object';
  if (/^null\b/.test(value)) return 'null';
  return 'unknown';
}

function exampleForField(name: string, type: EndpointField['type']) {
  const lower = name.toLowerCase();
  if (type === 'number') return lower.includes('id') ? '101' : '24';
  if (type === 'boolean') return 'true';
  if (type === 'array') return '[]';
  if (type === 'object') return '{}';
  if (type === 'null') return 'null';
  if (lower.includes('email')) return 'guest@example.com';
  if (lower.includes('url') || lower.includes('image')) return 'https://example.com/pizza.png';
  if (lower.includes('name') || lower.includes('title')) return 'Margherita Pizza';
  if (lower.includes('status')) return 'ready';
  if (lower.includes('date') || lower.includes('time')) return '2026-06-20T12:00:00.000Z';
  return 'sample';
}

function mockValue(name: string, type: EndpointField['type']) {
  const lower = name.toLowerCase();
  if (type === 'number') return lower.includes('price') || lower.includes('total') ? 18.5 : 1;
  if (type === 'boolean') return true;
  if (type === 'array') return [];
  if (type === 'object') return {};
  if (type === 'null') return null;
  if (lower.includes('email')) return 'qa@example.com';
  if (lower.includes('id')) return 'mock_001';
  if (lower.includes('name')) return 'Margherita Stable';
  if (lower.includes('status')) return 'ok';
  return exampleForField(name, type);
}

function inferFields(source: string) {
  const fields = new Map<string, EndpointField>();
  const objectKeyPattern = /(?:["']?)([A-Za-z_][A-Za-z0-9_]*)(?:["']?)\s*:\s*([^,\n}]+)/g;

  for (const match of source.matchAll(objectKeyPattern)) {
    const name = match[1];
    if (['headers', 'body', 'params', 'query', 'request', 'response'].includes(name)) continue;
    if (fields.has(name)) continue;

    const type = detectType(match[2]);
    fields.set(name, {
      name,
      type,
      example: exampleForField(name, type),
    });
  }

  return [...fields.values()].slice(0, 10);
}

function mockFromFields(fields: EndpointField[]) {
  return fields.reduce<Record<string, unknown>>((mock, field) => {
    mock[field.name] = mockValue(field.name, field.type);
    return mock;
  }, {});
}

function statusFromMethod(method: string) {
  return method === 'POST' ? 201 : 200;
}

function buildEndpoint(
  method: string,
  routePath: string,
  filePath: string,
  framework: string,
  sourceSlice: string,
  confidence: EndpointDefinition['confidence'],
): EndpointDefinition {
  const fields = inferFields(sourceSlice);
  const fallbackFields: EndpointField[] =
    fields.length > 0
      ? fields
      : [
          { name: 'id', type: 'string', example: 'mock_001' },
          { name: 'status', type: 'string', example: 'ok' },
        ];

  return {
    id: `${method}:${routePath}:${filePath}`,
    method,
    path: normalizeRoutePath(routePath),
    filePath,
    framework,
    status: statusFromMethod(method),
    confidence,
    fields: fallbackFields,
    mock: mockFromFields(fallbackFields),
  };
}

/**
 * Build an inventory entry for an endpoint observed at runtime through the sidecar
 * proxy or the capture interceptor (no source file). High confidence — it's a real
 * request the running app actually made. When a captured response `mock` is given
 * (from the network interceptor), it becomes the endpoint's realistic mock; without
 * one it keeps the generic {id,status} fallback (e.g. proxy discovery with no body).
 */
export function buildObservedEndpoint(
  method: string,
  routePath: string,
  mock?: MockBody,
): EndpointDefinition {
  // Tag captured rows distinctly so the renderer can upgrade an existing
  // endpoint's synthetic mock to a real captured body (proxy discovery, which
  // has no body, stays 'observed (runtime)').
  const framework = mock !== undefined ? 'observed (captured)' : 'observed (runtime)';
  const endpoint = buildEndpoint(method.toUpperCase(), routePath, '', framework, '', 'high');
  if (mock !== undefined) endpoint.mock = mock;
  return endpoint;
}

function detectCodeRoutes(repoPath: string, filePath: string, source: string) {
  const endpoints: EndpointDefinition[] = [];
  const expressPattern =
    /(?:app|router|server|fastify)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;

  for (const match of source.matchAll(expressPattern)) {
    const method = match[1].toUpperCase();
    const start = Math.max(0, match.index ?? 0);
    endpoints.push(
      buildEndpoint(
        method,
        match[2],
        path.relative(repoPath, filePath),
        'Express/Fastify',
        source.slice(start, start + 2500),
        'high',
      ),
    );
  }

  const nextRoute = nextRouteFromFile(repoPath, filePath);
  if (nextRoute) {
    for (const method of httpMethods) {
      const exportPattern = new RegExp(
        `export\\s+async\\s+function\\s+${method}\\b|export\\s+function\\s+${method}\\b`,
      );
      if (exportPattern.test(source)) {
        endpoints.push(
          buildEndpoint(
            method,
            nextRoute,
            path.relative(repoPath, filePath),
            'Next.js App Router',
            source,
            'high',
          ),
        );
      }
    }

    if (endpoints.length === 0) {
      endpoints.push(
        buildEndpoint(
          'GET',
          nextRoute,
          path.relative(repoPath, filePath),
          'Next.js API route',
          source,
          'medium',
        ),
      );
    }
  }

  return endpoints;
}

// Receiver names whose `.get()/.post()` etc. are not HTTP calls. The leading-slash
// gate already rejects most of these (e.g. `map.get('key')`), but denylisting the
// common offenders is cheap defense in depth. `request` covers supertest's
// `request(app).get('/x')` in test suites.
const CALL_RECEIVER_DENYLIST = new Set([
  'localStorage',
  'sessionStorage',
  'searchParams',
  'params',
  'query',
  'headers',
  'cookies',
  'map',
  'cache',
  'store',
  'formData',
  '_',
  'lodash',
  'fs',
  'path',
  'request',
]);

const httpMethodSet = new Set(httpMethods);

// HTTP calls in test/fixture files are not real app endpoints.
function isTestFile(relPath: string) {
  return /(?:\.test\.|\.spec\.|__tests__\/|(?:^|\/)(?:cypress|e2e)\/)/.test(relPath);
}

/**
 * Normalize a URL literal pulled from a call site into a mockable route path.
 * Returns undefined when the literal isn't path-like (so non-HTTP `.get()` calls
 * such as `cookies.get('session')` are rejected by the caller). Template
 * interpolations (`${id}`) become `:param` segments to match the override matcher's
 * dynamic-segment rules; query/hash are dropped; absolute URLs keep their pathname
 * and are flagged external (the same-origin proxy can't intercept cross-origin).
 */
function normalizeCallPath(
  raw: string,
): { path: string; external: boolean; host?: string } | undefined {
  let value = raw.trim();
  let external = false;
  let host: string | undefined;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value.replace(/\$\{[^}]*\}/g, 'param'));
      external = true;
      host = url.host;
      value = url.pathname || '/';
    } catch {
      return undefined;
    }
  } else if (!value.startsWith('/')) {
    return undefined;
  }

  value = value.split('?')[0].split('#')[0];

  value = value
    .split('/')
    .map((seg) => {
      const whole = seg.match(/^\$\{\s*([A-Za-z_$][\w$]*)\s*\}$/);
      if (whole) return `:${whole[1]}`;
      if (seg.includes('${')) return seg.replace(/\$\{[^}]*\}/g, 'param');
      return seg;
    })
    .join('/');

  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return { path: value, external, host };
}

// --- AST-based call detection (replaces the old line-window regex scan) ---
//
// The regex scanner only saw a call when a *string literal* immediately followed
// `(`, so it missed every real-world shape that isn't `fetch('/x')`: URLs built
// from a const (`BASE + '/x'`), config-object forms (`axios({url})`, `$.ajax({url})`),
// and hook wrappers (`useSWR('/x')`). Parsing each file to a TS AST lets us read the
// call's structure regardless of formatting and fold simple constants, so those
// literal-but-not-regex-shaped endpoints become mockable. Truly dynamic URLs
// (runtime data/env) remain runtime-discovery's job.

function scriptKindForFile(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.mjs':
    case '.cjs':
    case '.js':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

// Build a map of `const NAME = <string>` bindings so a URL assembled from a constant
// (`const BASE='/api'; fetch(BASE+'/x')`) can be folded to its literal value. Only
// string-resolvable initializers are recorded; values are resolved lazily with a
// cycle guard so `const B = A + '/x'` works regardless of declaration order.
function collectStringConstants(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const raw = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!raw.has(node.name.text)) raw.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return raw;
}

// Resolve an expression node to a concrete URL string when statically knowable.
// Template substitutions of a *bare identifier* are preserved as `${name}` so the
// caller's normalizeCallPath maps them to `:name` segments (matching prior behavior);
// substitutions that fold to a const string are inlined. Returns undefined when any
// part is unresolvable (computed at runtime) — those are left to runtime discovery.
function resolveUrlString(
  node: ts.Expression,
  constants: Map<string, ts.Expression>,
  seen = new Set<string>(),
): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;

  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const expr = span.expression;
      const folded = resolveUrlString(expr, constants, seen);
      if (folded !== undefined) {
        out += folded;
      } else if (ts.isIdentifier(expr)) {
        out += `\${${expr.text}}`;
      } else {
        out += '${param}';
      }
      out += span.literal.text;
    }
    return out;
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveUrlString(node.left, constants, seen);
    const right = resolveUrlString(node.right, constants, seen);
    if (left === undefined || right === undefined) return undefined;
    return left + right;
  }

  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return undefined;
    const bound = constants.get(node.text);
    if (!bound) return undefined;
    return resolveUrlString(bound, constants, new Set(seen).add(node.text));
  }

  if (ts.isParenthesizedExpression(node)) {
    return resolveUrlString(node.expression, constants, seen);
  }

  return undefined;
}

// Read `method: 'POST'` out of an options/config object literal.
function methodFromObjectLiteral(node: ts.ObjectLiteralExpression): string | undefined {
  for (const prop of node.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === 'method' &&
      ts.isStringLiteralLike(prop.initializer)
    ) {
      const method = prop.initializer.text.toUpperCase();
      return httpMethodSet.has(method) ? method : undefined;
    }
  }
  return undefined;
}

// Pull the `url` value out of a config object (`axios({url})`, `$.ajax({url})`).
function urlPropFromObjectLiteral(
  node: ts.ObjectLiteralExpression,
  constants: Map<string, ts.Expression>,
): string | undefined {
  for (const prop of node.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === 'url'
    ) {
      return resolveUrlString(prop.initializer, constants, new Set());
    }
  }
  return undefined;
}

// Strip `await`/`(...)`/non-null/`as` wrappers to reach the underlying call argument.
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

// Hook/wrapper callees whose first argument is conventionally the request URL.
const URL_FIRST_ARG_CALLEES = new Set(['useSWR', 'useSWRImmutable', 'useQuery']);
// Method names whose argument is a `{ url, method }` config object: `$.ajax({url})`,
// `axios.request({url})`.
const CONFIG_OBJECT_METHOD_NAMES = new Set(['ajax', 'request']);

// Walk a receiver/callee chain to its leftmost identifier so the denylist also rejects
// chained receivers, e.g. supertest's `request(app).get('/x')` (leftmost = `request`)
// while still allowing `axios.create().get('/x')` (leftmost = `axios`).
function leftmostIdentifier(node: ts.Expression): string | undefined {
  let current: ts.Expression = unwrapExpression(node);
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      current = current.expression;
    } else {
      return undefined;
    }
  }
}

function buildCallEndpoint(
  method: string,
  normalized: { path: string; external: boolean; host?: string },
  relFilePath: string,
  clientLabel: string,
): EndpointDefinition {
  const framework = normalized.external
    ? `external call${normalized.host ? ` (${normalized.host})` : ''}`
    : clientLabel;
  // Empty source slice: a call site has no response body to infer fields from, so
  // fall back to the generic {id,status} mock instead of scraping caller-side keys.
  return buildEndpoint(
    method,
    normalized.path,
    relFilePath,
    framework,
    '',
    normalized.external ? 'low' : 'medium',
  );
}

/**
 * Detect outbound API calls the app *makes* by walking the file's TS/JS AST:
 * `fetch('/x')`, `axios('/x'|{url})`, `axios.get('/x')`, generic `IDENT.method('/x')`
 * on any receiver, config-object forms (`$.ajax({url})`), and URL-first hooks
 * (`useSWR('/x')`) — with intra-file const-folding (`BASE + '/x'`). These call sites
 * yield the `METHOD:path` the mock proxy needs, so detecting them makes an endpoint
 * mockable even when no route-definition source file exists. Only *statically
 * resolvable* URLs are reachable here; URLs computed from runtime data are caught by
 * runtime discovery (the always-on proxy).
 */
function detectApiCalls(repoPath: string, filePath: string, source: string) {
  const relFilePath = path.relative(repoPath, filePath);
  if (isTestFile(relFilePath.replaceAll(path.sep, '/'))) return [];

  const scriptKind = scriptKindForFile(filePath);
  if (scriptKind === ts.ScriptKind.Unknown) return [];

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  } catch {
    return []; // unparseable file — leave it to runtime discovery
  }

  const constants = collectStringConstants(sourceFile);
  const endpoints: EndpointDefinition[] = [];

  const record = (method: string, urlString: string | undefined, label: string) => {
    if (urlString === undefined) return;
    const normalized = normalizeCallPath(urlString);
    if (!normalized) return;
    endpoints.push(buildCallEndpoint(method, normalized, relFilePath, label));
  };

  const resolveArg = (arg: ts.Expression | undefined) =>
    arg ? resolveUrlString(unwrapExpression(arg), constants, new Set()) : undefined;

  const methodFromOptionsArg = (arg: ts.Expression | undefined): string => {
    if (!arg) return 'GET';
    const unwrapped = unwrapExpression(arg);
    return ts.isObjectLiteralExpression(unwrapped)
      ? (methodFromObjectLiteral(unwrapped) ?? 'GET')
      : 'GET';
  };

  const handleCall = (call: ts.CallExpression) => {
    const callee = call.expression;
    const arg0 = call.arguments[0];
    const arg0Unwrapped = arg0 ? unwrapExpression(arg0) : undefined;

    // IDENT.method(...) — axios.get, api.post, client.get, $.ajax, ky.get
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      const methodName = callee.name.text.toLowerCase();

      // Config-object form: `$.ajax({url, method})`, `axios.request({url})`.
      if (
        CONFIG_OBJECT_METHOD_NAMES.has(methodName) &&
        arg0Unwrapped &&
        ts.isObjectLiteralExpression(arg0Unwrapped)
      ) {
        record(
          methodFromObjectLiteral(arg0Unwrapped) ?? 'GET',
          urlPropFromObjectLiteral(arg0Unwrapped, constants),
          'HTTP client call',
        );
        return;
      }

      // Verb method: `receiver.get('/x')`. Denylist the receiver chain.
      if (httpMethodSet.has(methodName.toUpperCase())) {
        const receiver = leftmostIdentifier(callee.expression);
        if (receiver && CALL_RECEIVER_DENYLIST.has(receiver)) return;
        record(methodName.toUpperCase(), resolveArg(arg0), 'HTTP client call');
      }
      return;
    }

    // Bare identifier call — fetch(...), axios(...), ky(...), useSWR(...)
    if (ts.isIdentifier(callee)) {
      const name = callee.text;

      if (name === 'fetch') {
        record(methodFromOptionsArg(call.arguments[1]), resolveArg(arg0), 'fetch');
        return;
      }

      if (name === 'axios' || name === 'ky' || name === 'got') {
        const label = name === 'axios' ? 'axios' : 'HTTP client call';
        // Config-object form: `axios({ url, method })`.
        if (arg0Unwrapped && ts.isObjectLiteralExpression(arg0Unwrapped)) {
          record(
            methodFromObjectLiteral(arg0Unwrapped) ?? 'GET',
            urlPropFromObjectLiteral(arg0Unwrapped, constants),
            label,
          );
          return;
        }
        record(methodFromOptionsArg(call.arguments[1]), resolveArg(arg0), label);
        return;
      }

      if (URL_FIRST_ARG_CALLEES.has(name)) {
        record('GET', resolveArg(arg0), 'data hook');
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) handleCall(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return endpoints;
}

function detectOpenApiRoutes(repoPath: string, filePath: string, source: string) {
  if (!/openapi|swagger/i.test(path.basename(filePath))) return [];

  try {
    const parsed = JSON.parse(source);
    const paths = parsed.paths && typeof parsed.paths === 'object' ? parsed.paths : {};
    const endpoints: EndpointDefinition[] = [];

    for (const [routePath, methods] of Object.entries<Record<string, unknown>>(paths)) {
      for (const method of Object.keys(methods)) {
        if (httpMethods.includes(method.toUpperCase())) {
          endpoints.push(
            buildEndpoint(
              method.toUpperCase(),
              routePath,
              path.relative(repoPath, filePath),
              'OpenAPI',
              JSON.stringify(methods[method]).slice(0, 2500),
              'high',
            ),
          );
        }
      }
    }

    return endpoints;
  } catch {
    return [];
  }
}

export async function scanEndpoints(repoPath: string) {
  const files = await walkFiles(repoPath);
  const endpoints: EndpointDefinition[] = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    endpoints.push(...detectCodeRoutes(repoPath, filePath, source));
    endpoints.push(...detectApiCalls(repoPath, filePath, source));
    endpoints.push(...detectOpenApiRoutes(repoPath, filePath, source));
  }

  // On a METHOD:path collision keep the higher-confidence detection so a real route
  // definition (high) always beats a duplicate call-site detection (medium/low),
  // regardless of file-walk order. Ties keep the first seen.
  const confidenceRank: Record<EndpointDefinition['confidence'], number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  const deduped = new Map<string, EndpointDefinition>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method}:${endpoint.path}`;
    const existing = deduped.get(key);
    if (!existing || confidenceRank[endpoint.confidence] > confidenceRank[existing.confidence]) {
      deduped.set(key, endpoint);
    }
  }

  return [...deduped.values()].sort((a, b) =>
    `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`),
  );
}
