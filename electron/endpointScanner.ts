import fs from 'node:fs/promises';
import path from 'node:path';
import type { EndpointDefinition, EndpointField } from './types.js';

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
    endpoints.push(...detectOpenApiRoutes(repoPath, filePath, source));
  }

  const deduped = new Map<string, EndpointDefinition>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method}:${endpoint.path}`;
    if (!deduped.has(key)) deduped.set(key, endpoint);
  }

  return [...deduped.values()].sort((a, b) =>
    `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`),
  );
}
