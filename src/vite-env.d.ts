/// <reference types="vite/client" />

import type {
  ChangeLinkResult,
  ChangeProbe,
  EndpointDefinition,
  RepositorySummary,
  ServerLogEntry,
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
      // Resolve (and create) the repo's overlay folder; open it in the OS file
      // manager when `open` is true. Returns the absolute folder path.
      overlayFolder: (repoPath: string, open?: boolean) => Promise<string>;
      // Subscribe to streamed server/page log lines (sidecar + visual diff).
      // Returns an unsubscribe function.
      onServerLog: (callback: (entry: ServerLogEntry) => void) => () => void;
      // Forward a sidecar preview-page console message into the run log.
      appendLog: (entry: { text: string; level?: string }) => Promise<void>;
      // Reveal a run's log file in the OS file manager.
      revealLog: (file: string) => Promise<string>;
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
