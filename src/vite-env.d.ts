/// <reference types="vite/client" />

import type {
  ChangeLinkResult,
  ChangeProbe,
  EndpointDefinition,
  RepositorySummary,
  SidecarStatus,
  VisualDiffReport,
  VisualDiffRequest,
  WorkspaceSelection,
} from './lib/types';
import type * as React from 'react';

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
      setSidecarOverrides: (
        overrides: Record<string, Record<string, unknown>>,
      ) => Promise<SidecarStatus>;
      runVisualDiff: (request: VisualDiffRequest) => Promise<VisualDiffReport>;
      getChangedFiles: (request: {
        repoPath: string;
        baseRef: string;
        targetRef: string;
      }) => Promise<string[]>;
      linkChanges: (request: {
        repoPath: string;
        baseRef: string;
        targetRef: string;
        elements: ChangeProbe[];
      }) => Promise<ChangeLinkResult[]>;
    };
  }

  // Electron <webview> tag (enabled via webviewTag in electron/main.ts). Without
  // this augmentation, tsc -p tsconfig.json fails on the element in SidecarPanel.
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
        preload?: string;
      };
    }
  }
}
