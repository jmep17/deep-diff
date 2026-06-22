import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChangedFilesRequest,
  GitHubBranchRequest,
  GitHubRepositoryRequest,
  SidecarLaunchRequest,
  VisualDiffRequest,
} from './types.js';

contextBridge.exposeInMainWorld('deepDiff', {
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  listLocalBranches: (repoPath: string) => ipcRenderer.invoke('repo:listBranches', repoPath),
  scanEndpoints: (repoPath: string) => ipcRenderer.invoke('repo:scanEndpoints', repoPath),
  fetchGitHubRepos: (request: GitHubRepositoryRequest) =>
    ipcRenderer.invoke('github:listRepos', request),
  fetchGitHubBranches: (request: GitHubBranchRequest) =>
    ipcRenderer.invoke('github:listBranches', request),
  launchSidecar: (request: SidecarLaunchRequest) => ipcRenderer.invoke('sidecar:launch', request),
  stopSidecar: () => ipcRenderer.invoke('sidecar:stop'),
  getSidecarStatus: () => ipcRenderer.invoke('sidecar:status'),
  setSidecarOverrides: (overrides: Record<string, Record<string, unknown>>) =>
    ipcRenderer.invoke('sidecar:setOverrides', overrides),
  runVisualDiff: (request: VisualDiffRequest) => ipcRenderer.invoke('diff:run', request),
  getChangedFiles: (request: ChangedFilesRequest) => ipcRenderer.invoke('changes:files', request),
  linkChanges: (request: ChangedFilesRequest & { elements: unknown[] }) =>
    ipcRenderer.invoke('changes:link', request),
  overlayFolder: (repoPath: string, open?: boolean) =>
    ipcRenderer.invoke('overlay:folder', { repoPath, open }),
});
