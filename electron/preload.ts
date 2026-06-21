import { contextBridge, ipcRenderer } from 'electron';
import type {
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
  runVisualDiff: (request: VisualDiffRequest) => ipcRenderer.invoke('diff:run', request),
});
