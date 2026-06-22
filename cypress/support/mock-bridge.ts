import type {
  EndpointDefinition,
  RepositorySummary,
  SidecarStatus,
  VisualDiffReport,
  VisualDiffRequest,
  WorkspaceSelection,
} from '../../src/lib/types';

const PNG_RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const PNG_BLUE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_GOLD =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+BCwAHggJ/PchI7wAAAABJRU5ErkJggg==';

export interface MockBridgeOptions {
  endpoints?: EndpointDefinition[];
  visualDiffDelayMs?: number;
  report?: VisualDiffReport;
}

function routeId(path: string, status: 'passed' | 'failed') {
  return `${path}:${status}`;
}

export function buildFixtureVisualDiffReport(): VisualDiffReport {
  const changedPaths = ['/', '/pricing', '/dashboard/settings/auth0'];
  const unchangedPaths = ['/dashboard', '/projects/:projectId', '/reports/:reportId'];

  const changedRoutes = changedPaths.map((path, index) => ({
    id: routeId(path, 'failed'),
    path,
    urlPath:
      path === '/projects/:projectId'
        ? '/projects/project_alpha'
        : path === '/reports/:reportId'
          ? '/reports/report_2026'
          : path,
    status: 'failed' as const,
    mismatchPixels: 1200 + index * 150,
    mismatchRatio: 0.08 + index * 0.01,
    beforeImage: PNG_RED,
    afterImage: PNG_BLUE,
    diffImage: PNG_GOLD,
  }));

  const unchangedRoutes = unchangedPaths.map((path) => ({
    id: routeId(path, 'passed'),
    path,
    urlPath:
      path === '/projects/:projectId'
        ? '/projects/project_alpha'
        : path === '/reports/:reportId'
          ? '/reports/report_2026'
          : path,
    status: 'passed' as const,
    mismatchPixels: 0,
    mismatchRatio: 0,
    beforeImage: PNG_RED,
    afterImage: PNG_RED,
    diffImage: PNG_RED,
  }));

  return {
    id: 'report-cypress-fixture',
    repoPath: '/mock/auth0-routes-fixture',
    baseRef: 'main',
    targetRef: 'feature/auth0-preview-callbacks',
    baseUrl: 'http://127.0.0.1:3201',
    targetUrl: 'http://127.0.0.1:3202',
    createdAt: '2026-06-20T14:00:00.000Z',
    durationMs: 5100,
    viewport: { width: 1280, height: 900 },
    routes: [...changedRoutes, ...unchangedRoutes],
    changedRoutes: changedPaths.length,
    totalRoutes: changedPaths.length + unchangedPaths.length,
  };
}

const mockRepositories: RepositorySummary[] = [
  {
    id: 'auth0-routes-fixture',
    name: 'auth0-routes-fixture',
    fullName: 'Deep Dish Diff / auth0-routes-fixture',
    source: 'local',
    path: '/mock/auth0-routes-fixture',
    defaultBranch: 'main',
    description: 'Auth0 routes mock repository',
  },
];

const mockBranches = ['main', 'feature/auth0-preview-callbacks', 'feature/order-flow'];

const mockEndpoints: EndpointDefinition[] = [
  {
    id: 'GET:/api/public/status',
    method: 'GET',
    path: '/api/public/status',
    filePath: 'app/api/public/status/route.ts',
    framework: 'Next.js App Router',
    status: 200,
    confidence: 'high',
    fields: [
      { name: 'id', type: 'string', example: 'status_fixture' },
      { name: 'status', type: 'string', example: 'ok' },
    ],
    mock: { id: 'status_fixture', status: 'ok' },
  },
  {
    id: 'GET:/api/auth/:auth0',
    method: 'GET',
    path: '/api/auth/:auth0',
    filePath: 'app/api/auth/[auth0]/route.ts',
    framework: 'Next.js App Router',
    status: 200,
    confidence: 'high',
    fields: [
      { name: 'callbackUrl', type: 'string', example: 'https://example.com/api/auth/callback' },
      { name: 'status', type: 'string', example: 'redirect-ready' },
    ],
    mock: { callbackUrl: 'https://example.com/api/auth/callback', status: 'redirect-ready' },
  },
];

export function buildMockBridge(options: MockBridgeOptions = {}) {
  const report = options.report ?? buildFixtureVisualDiffReport();
  const endpoints = options.endpoints ?? mockEndpoints;
  const delayMs = options.visualDiffDelayMs ?? 250;

  return {
    selectWorkspace: async (): Promise<WorkspaceSelection> => ({
      workspacePath: '/mock/mock-repositories',
      repositories: mockRepositories,
    }),
    listLocalBranches: async () => mockBranches,
    scanEndpoints: async () => endpoints,
    fetchGitHubRepos: async () => [],
    fetchGitHubBranches: async () => mockBranches,
    launchSidecar: async (): Promise<SidecarStatus> => ({
      running: true,
      url: 'http://127.0.0.1:3199',
      port: 3199,
      pid: 4242,
      command: 'pnpm run dev',
      startedAt: new Date().toISOString(),
    }),
    stopSidecar: async (): Promise<SidecarStatus> => ({ running: false }),
    getSidecarStatus: async (): Promise<SidecarStatus> => ({ running: false }),
    // Faithful no-op fake of the live-override IPC. Specs stub this on the live
    // window.deepDiff to assert that toolbar toggles push override changes to a
    // running sidecar without a relaunch. Returns the same URL so the keyed
    // <webview> is reloaded in place rather than remounted.
    setSidecarOverrides: async (
      _overrides: Record<string, Record<string, unknown>>,
    ): Promise<SidecarStatus> => ({
      running: true,
      url: 'http://127.0.0.1:3199',
      port: 3199,
      pid: 4242,
      command: 'pnpm run dev',
      startedAt: new Date().toISOString(),
    }),
    runVisualDiff: async (_request: VisualDiffRequest) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return report;
    },
  };
}
