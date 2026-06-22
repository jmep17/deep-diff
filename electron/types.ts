import type { EndpointOverrides } from './overrideMatcher.js';

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
  token?: string;
}

export interface GitHubBranchRequest {
  owner: string;
  repository: string;
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
}
