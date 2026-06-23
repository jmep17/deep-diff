import type { EndpointOverrides } from './overrideMatcher.js';
import type { LogServer, LogSource, LogStream, ServerLogEntry } from './serverLogs.js';

// Re-exported so the shared log shapes have a single source of truth in the main
// process (the renderer mirrors them independently in src/lib/types.ts).
export type { LogServer, LogSource, LogStream, ServerLogEntry };

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

export interface GitHubRepositoryRequest {
  organization: string;
  // Main-process-internal: the token resolved by resolveGitHubToken (env / gh CLI),
  // never renderer-supplied. The IPC validators do not accept a token from the renderer.
  token?: string;
}

export interface GitHubBranchRequest {
  owner: string;
  repository: string;
  // See GitHubRepositoryRequest.token — main-process-internal carrier, not renderer-supplied.
  token?: string;
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

export interface SidecarLaunchRequest {
  repoPath?: string;
  branch?: string;
  command?: string;
  endpointOverrides?: EndpointOverrides;
  // Absolute path to a per-repo overlay folder, resolved and set by the main process
  // (never supplied by the renderer). Its contents are copied over the capture worktree.
  overlayDir?: string;
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
  // Absolute path to a per-repo overlay folder, resolved and set by the main process
  // (never supplied by the renderer). Its contents are copied over each capture worktree.
  overlayDir?: string;
}

export interface ChangedFilesRequest {
  repoPath: string;
  baseRef: string;
  targetRef: string;
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
