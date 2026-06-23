import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ChangedFilesRequest,
  EndpointDefinition,
  GitHubBranchRequest,
  GitHubRepositoryRequest,
  ServerLogEntry,
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
  // Subscribe to streamed server/page log lines. Returns an unsubscribe fn.
  onServerLog: (callback: (entry: ServerLogEntry) => void) => {
    const handler = (_event: IpcRendererEvent, entry: ServerLogEntry) => callback(entry);
    ipcRenderer.on('logs:event', handler);
    return () => ipcRenderer.off('logs:event', handler);
  },
  // Subscribe to endpoints discovered at runtime through the sidecar proxy (so they
  // join the mockable inventory). Returns an unsubscribe fn.
  onObservedEndpoints: (callback: (endpoint: EndpointDefinition) => void) => {
    const handler = (_event: IpcRendererEvent, endpoint: EndpointDefinition) => callback(endpoint);
    ipcRenderer.on('endpoints:observed', handler);
    return () => ipcRenderer.off('endpoints:observed', handler);
  },
  // Forward a sidecar preview-page console message into the run log.
  appendLog: (entry: { text: string; level?: string }) => ipcRenderer.invoke('logs:append', entry),
  // Reveal a run's log file in the OS file manager.
  revealLog: (file: string) => ipcRenderer.invoke('logs:reveal', { file }),
  // Persisted UI state (profiles, edited mock bodies, settings) in userData.
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state: unknown) => ipcRenderer.invoke('state:save', state),
  // Overlay-folder config files (app-owned storage under userData/overlays).
  listOverlayFiles: (repoPath: string) => ipcRenderer.invoke('overlay:list', { repoPath }),
  readOverlayFile: (repoPath: string, relPath: string) =>
    ipcRenderer.invoke('overlay:readFile', { repoPath, relPath }),
  writeOverlayFile: (repoPath: string, relPath: string, content: string) =>
    ipcRenderer.invoke('overlay:writeFile', { repoPath, relPath, content }),
  deleteOverlayFile: (repoPath: string, relPath: string) =>
    ipcRenderer.invoke('overlay:deleteFile', { repoPath, relPath }),
});
