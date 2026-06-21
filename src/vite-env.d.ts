/// <reference types="vite/client" />

import type {
  EndpointDefinition,
  RepositorySummary,
  SidecarStatus,
  VisualDiffReport,
  VisualDiffRequest,
  WorkspaceSelection,
} from './lib/types';

declare global {
  interface Window {
    deepDiff?: {
      selectWorkspace: () => Promise<WorkspaceSelection | null>;
      listLocalBranches: (repoPath: string) => Promise<string[]>;
      scanEndpoints: (repoPath: string) => Promise<EndpointDefinition[]>;
      fetchGitHubRepos: (request: {
        organization: string;
        token?: string;
      }) => Promise<RepositorySummary[]>;
      fetchGitHubBranches: (request: {
        owner: string;
        repository: string;
        token?: string;
      }) => Promise<string[]>;
      launchSidecar: (request: {
        repoPath?: string;
        branch?: string;
        command?: string;
        endpointOverrides?: Record<string, Record<string, unknown>>;
      }) => Promise<SidecarStatus>;
      stopSidecar: () => Promise<SidecarStatus>;
      getSidecarStatus: () => Promise<SidecarStatus>;
      runVisualDiff: (request: VisualDiffRequest) => Promise<VisualDiffReport>;
    };
  }
}
