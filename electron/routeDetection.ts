import fs from 'node:fs/promises';
import path from 'node:path';

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

const pageExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const sharedImpactExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json']);

export interface VisualRoute {
  path: string;
  urlPath: string;
  sourceFile: string;
}

async function walkFiles(root: string, files: string[] = []) {
  const entries = await fs.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walkFiles(path.join(root, entry.name), files);
      }
      continue;
    }

    if (entry.isFile() && pageExtensions.has(path.extname(entry.name))) {
      files.push(path.join(root, entry.name));
    }
  }

  return files;
}

export function normalizeRoutePath(value: string) {
  if (!value || value === '/') return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizeRelativePath(repoPath: string, filePath: string) {
  const absoluteRepoPath = path.resolve(repoPath);

  if (path.isAbsolute(filePath)) {
    return path.relative(absoluteRepoPath, filePath).replaceAll(path.sep, '/');
  }

  const resolvedFromCwd = path.resolve(filePath);
  const absolutePath =
    resolvedFromCwd === absoluteRepoPath ||
    resolvedFromCwd.startsWith(`${absoluteRepoPath}${path.sep}`)
      ? resolvedFromCwd
      : path.join(absoluteRepoPath, filePath);

  return path.relative(absoluteRepoPath, absolutePath).replaceAll(path.sep, '/');
}

function sampleSegment(segment: string) {
  const dynamic = segment.match(/^\[\[?\.?\.?([^\]]+)\]?\]$/);
  if (!dynamic) return segment;

  const name = dynamic[1].toLowerCase();
  if (name.includes('project')) return 'project_alpha';
  if (name.includes('report')) return 'report_2026';
  if (name.includes('order')) return 'order_1001';
  if (name.includes('product')) return 'prod_keyboard';
  if (name.includes('user')) return 'user_fixture';
  return `${name}_fixture`;
}

function displaySegment(segment: string) {
  const dynamic = segment.match(/^\[\[?\.?\.?([^\]]+)\]?\]$/);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

function routeFromSegments(segments: string[]) {
  const publicSegments = segments.filter((segment) => segment && !segment.startsWith('('));
  return {
    path: normalizeRoutePath(publicSegments.map(displaySegment).join('/')),
    urlPath: normalizeRoutePath(publicSegments.map(sampleSegment).join('/')),
  };
}

export function pageRouteFromRelativePath(relativePath: string): VisualRoute | undefined {
  const sourceFile = relativePath.replaceAll(path.sep, '/');

  if (
    sourceFile === 'app/page.tsx' ||
    sourceFile === 'app/page.jsx' ||
    sourceFile === 'app/page.js'
  ) {
    return { path: '/', urlPath: '/', sourceFile };
  }

  const appMatch = sourceFile.match(/^app\/(.+)\/page\.(tsx?|jsx?|mjs|cjs)$/);
  if (appMatch && !appMatch[1].startsWith('api/')) {
    return { ...routeFromSegments(appMatch[1].split('/')), sourceFile };
  }

  const pagesMatch = sourceFile.match(/^pages\/(.+)\.(tsx?|jsx?|mjs|cjs)$/);
  if (pagesMatch && !pagesMatch[1].startsWith('api/')) {
    const segments = pagesMatch[1].replace(/\/index$/, '').split('/');
    return { ...routeFromSegments(segments), sourceFile };
  }

  return undefined;
}

export function pageRouteFromFile(repoPath: string, filePath: string): VisualRoute | undefined {
  return pageRouteFromRelativePath(normalizeRelativePath(repoPath, filePath));
}

function hasSharedRouteImpact(relativePath: string) {
  if (pageRouteFromRelativePath(relativePath)) return false;
  if (relativePath.startsWith('app/api/') || relativePath.startsWith('pages/api/')) return false;

  const extension = path.extname(relativePath);
  return (
    sharedImpactExtensions.has(extension) ||
    relativePath.startsWith('src/') ||
    relativePath.startsWith('auth0/') ||
    relativePath.startsWith('middleware.') ||
    relativePath.startsWith('.env')
  );
}

export async function scanVisualRoutes(repoPath: string) {
  const files = await walkFiles(repoPath);
  const routes = new Map<string, VisualRoute>();

  for (const filePath of files) {
    const route = pageRouteFromFile(repoPath, filePath);
    if (route && !routes.has(route.path)) routes.set(route.path, route);
  }

  if (routes.size === 0) {
    routes.set('/', { path: '/', urlPath: '/', sourceFile: 'fallback' });
  }

  return [...routes.values()].sort((a, b) => {
    if (a.path === '/') return -1;
    if (b.path === '/') return 1;
    return a.path.localeCompare(b.path);
  });
}

export function detectVisualRoutesForChangedFiles(
  repoPath: string,
  changedFiles: string[],
  allRoutes: VisualRoute[] = [],
) {
  const directRoutes = new Map<string, VisualRoute>();
  let sharedImpact = false;

  for (const changedFile of changedFiles) {
    const relativePath = normalizeRelativePath(repoPath, changedFile);
    const directRoute = pageRouteFromRelativePath(relativePath);

    if (directRoute) {
      directRoutes.set(directRoute.path, directRoute);
      continue;
    }

    if (hasSharedRouteImpact(relativePath)) {
      sharedImpact = true;
    }
  }

  if (sharedImpact && allRoutes.length > 0) return allRoutes;
  return [...directRoutes.values()].sort((a, b) => {
    if (a.path === '/') return -1;
    if (b.path === '/') return 1;
    return a.path.localeCompare(b.path);
  });
}

export function selectRoutes(allRoutes: VisualRoute[], requestedRoutes?: string[]) {
  if (!requestedRoutes?.length) return allRoutes;

  const requested = new Set(requestedRoutes.map(normalizeRoutePath));
  return allRoutes.filter((route) => requested.has(route.path) || requested.has(route.urlPath));
}
