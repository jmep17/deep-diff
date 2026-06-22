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

export interface SidecarStatus {
  running: boolean;
  url?: string;
  port?: number;
  pid?: number;
  command?: string;
  startedAt?: string;
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
}
