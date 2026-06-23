export type RepositorySource = 'local' | 'github';

export interface RepositorySummary {
  id: string;
  name: string;
  fullName: string;
  source: RepositorySource;
  path?: string;
  owner?: string;
  defaultBranch?: string;
  description?: string | null;
  private?: boolean;
  url?: string;
}

export interface WorkspaceSelection {
  workspacePath: string;
  repositories: RepositorySummary[];
}

export interface EndpointField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'unknown';
  example: string;
}

export interface EndpointDefinition {
  id: string;
  method: string;
  path: string;
  filePath: string;
  framework: string;
  status: number;
  confidence: 'high' | 'medium' | 'low';
  fields: EndpointField[];
  mock: Record<string, unknown>;
}

export interface MockProfile {
  id: string;
  name: string;
  description: string;
  color: 'red' | 'green' | 'yellow';
  enabled: boolean;
  endpointOverrides: Record<string, Record<string, unknown>>;
}

// User-editable settings persisted to userData/state.json.
export interface PersistedSettings {
  githubOrg?: string;
  githubToken?: string;
  sensitivity?: number;
  viewport?: { width: number; height: number };
}

// Whole persisted UI state. `mockEdits` maps `METHOD:path` → an edited mock body
// applied onto freshly-scanned endpoints so per-endpoint mock edits survive a
// rescan/restart.
export interface PersistedState {
  version?: number;
  profiles?: MockProfile[];
  activeProfileId?: string;
  mockEdits?: Record<string, Record<string, unknown>>;
  settings?: PersistedSettings;
}

// Shared log shapes — mirror of electron/serverLogs.ts (the two processes have
// separate compiler configs and can't import across the main/renderer boundary).
export type LogSource = 'diff' | 'sidecar';
export type LogServer = 'base' | 'target' | 'sidecar';
export type LogStream = 'stdout' | 'stderr' | 'console' | 'install' | 'system' | 'network';

export interface ServerLogEntry {
  runId: string;
  source: LogSource;
  server: LogServer;
  stream: LogStream;
  level?: string;
  ts: number;
  text: string;
}

export interface SidecarStatus {
  running: boolean;
  url?: string;
  port?: number;
  pid?: number;
  command?: string;
  startedAt?: string;
  /** Absolute path to this launch's full log file (server stdout/stderr + page console). */
  logFile?: string;
}

export type DiffStatus = 'idle' | 'running' | 'passed' | 'failed';

export interface VisualDiffViewport {
  width: number;
  height: number;
}

export interface VisualDiffRequest {
  repoPath: string;
  baseRef: string;
  targetRef: string;
  viewport?: VisualDiffViewport;
  routes?: string[];
  command?: string;
  mismatchTolerance?: number;
  endpointOverrides?: Record<string, Record<string, unknown>>;
}

export interface ChangedFilesRequest {
  repoPath: string;
  baseRef: string;
  targetRef: string;
}

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A DOM element probed from the sidecar webview, with its raw source string. */
export interface ChangeProbe {
  id: string;
  sourcePath: string;
  rect?: ElementRect;
  tag?: string;
}

/** A probed element matched to a changed file (repo-relative `file`). */
export interface ChangeLinkResult extends ChangeProbe {
  file: string;
}

export interface VisualDiffRouteReport {
  id: string;
  path: string;
  urlPath: string;
  status: 'passed' | 'failed' | 'error';
  mismatchPixels: number;
  mismatchRatio: number;
  beforeImage: string;
  afterImage: string;
  diffImage: string;
  error?: string;
}

export interface VisualDiffReport {
  id: string;
  repoPath: string;
  baseRef: string;
  targetRef: string;
  baseUrl: string;
  targetUrl: string;
  createdAt: string;
  durationMs: number;
  viewport: VisualDiffViewport;
  routes: VisualDiffRouteReport[];
  changedRoutes: number;
  totalRoutes: number;
  /** Absolute path to this run's full log file (both servers' output + page console). */
  logFile?: string;
  /** Bounded snapshot of captured log entries for this run (the file is the full record). */
  logs?: ServerLogEntry[];
}
