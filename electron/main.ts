import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangeLinks, getChangedFiles } from './changeLink.js';
import { scanEndpoints } from './endpointScanner.js';
import {
  assertAuthorizedRepoPath,
  validateChangedFilesRequest,
  validateChangeLinkRequest,
  validateEndpointOverrides,
  validateGitHubBranchRequest,
  validateGitHubRepositoryRequest,
  validateSidecarLaunchRequest,
  validateVisualDiffRequest,
} from './ipcValidation.js';
import { logError } from './logger.js';
import {
  fetchGitHubBranches,
  fetchGitHubRepositories,
  listLocalBranches,
  scanWorkspace,
} from './repositories.js';
import { getSidecarStatus, launchSidecar, setSidecarOverrides, stopSidecar } from './sidecar.js';
import { runVisualDiff } from './visualDiff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Workspace directories explicitly chosen by the user via the open-dialog this session.
// All repoPath values arriving over IPC must be at or under one of these roots.
const authorizedRoots = new Set<string>();

/**
 * Wraps an ipcMain.handle registration to:
 * - log every error to the main-process console with channel context
 * - re-throw a normalized Error (preserving the original message) so the
 *   renderer receives a clear, specific rejection instead of an opaque failure
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerHandler(channel: string, handler: (...args: any[]) => any): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      logError(channel, err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  });
}

// Electron and the dev server (Vite / server.mjs) boot in parallel, so the
// first loadURL can beat the server's listen() and reject with
// ERR_CONNECTION_REFUSED, leaving a permanently blank window. `wait-on` in the
// dev script guards the normal path, but other launchers (e.g. an external
// runner that sets VITE_DEV_SERVER_URL itself) skip it. Retry until it's up.
async function loadDevServer(window: BrowserWindow, url: string): Promise<void> {
  const maxAttempts = 60; // ~30s at 500ms between tries
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (window.isDestroyed()) return;
    try {
      await window.loadURL(url);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const racing = code.startsWith('ERR_CONNECTION') || code === 'ERR_FAILED';
      if (!racing || attempt === maxAttempts) {
        logError('loadDevServer', err);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: 'Deep Diff',
    backgroundColor: '#faf3e6',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the <webview> tag used by the renderer's live "Browser preview"
      // (SidecarPanel) to embed the running sidecar URL. The guest itself gets
      // no nodeIntegration (omitted in markup) and a non-persistent partition.
      webviewTag: true,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  // --- Renderer hardening (defense-in-depth) ---------------------------------
  // The renderer is a single-page React app that never legitimately opens a new
  // window or navigates away from its own origin. Deny both by default so that
  // injected/compromised content cannot pivot to an external page or popup.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Allow same-origin navigations only (covers Vite HMR full reloads in dev).
  const appOrigin = devServerUrl ? new URL(devServerUrl).origin : null;
  const isSameOrigin = (url: string): boolean => {
    if (appOrigin === null) return false;
    try {
      return new URL(url).origin === appOrigin;
    } catch {
      return false;
    }
  };
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSameOrigin(url)) event.preventDefault();
  });

  // Enforce hardened webPreferences on the sidecar-preview <webview> at the
  // main-process layer, independent of the renderer markup, and confine the
  // guest to local sidecar URLs (the only thing it should ever embed).
  const hostnameOf = (url: string): string => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;

    // Block only a real external host. An empty/about:blank src (host '') can
    // fire at attach time before the renderer sets src={sidecar.url}; failing
    // closed there would silently break the live preview, so let it through —
    // the webPreferences enforcement above is the load-bearing protection.
    const host = hostnameOf(params.src);
    if (host && host !== '127.0.0.1' && host !== 'localhost') {
      event.preventDefault();
    }
  });

  if (devServerUrl) {
    await loadDevServer(mainWindow, devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  registerHandler('workspace:select', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select an organization or workspace folder',
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    // Authorize the chosen directory before scanning so that subsequent calls
    // for repos discovered within it pass the path-containment check.
    const realRoot = await fs.realpath(result.filePaths[0]);
    authorizedRoots.add(realRoot);

    return scanWorkspace(result.filePaths[0]);
  });

  registerHandler('repo:listBranches', async (_event, repoPath) => {
    const validated = await assertAuthorizedRepoPath(repoPath, authorizedRoots);
    return listLocalBranches(validated);
  });

  registerHandler('repo:scanEndpoints', async (_event, repoPath) => {
    const validated = await assertAuthorizedRepoPath(repoPath, authorizedRoots);
    return scanEndpoints(validated);
  });

  registerHandler('github:listRepos', (_event, raw) => {
    const request = validateGitHubRepositoryRequest(raw);
    return fetchGitHubRepositories(request);
  });

  registerHandler('github:listBranches', (_event, raw) => {
    const request = validateGitHubBranchRequest(raw);
    return fetchGitHubBranches(request);
  });

  registerHandler('sidecar:launch', async (_event, raw) => {
    const request = await validateSidecarLaunchRequest(raw, authorizedRoots);
    return launchSidecar(request);
  });

  registerHandler('sidecar:stop', () => stopSidecar());
  registerHandler('sidecar:status', () => getSidecarStatus());

  // Apply mock-override changes to the already-running sidecar (no relaunch).
  // No repoPath is involved — this mutates the live proxy's override map — so
  // only the payload shape is validated, consistent with the handler-layer rule.
  registerHandler('sidecar:setOverrides', (_event, raw) => {
    const overrides = validateEndpointOverrides(raw);
    return setSidecarOverrides(overrides);
  });

  registerHandler('diff:run', async (_event, raw) => {
    const request = await validateVisualDiffRequest(raw, authorizedRoots);
    return runVisualDiff(request);
  });

  registerHandler('changes:files', async (_event, raw) => {
    const request = await validateChangedFilesRequest(raw, authorizedRoots);
    return getChangedFiles(request.repoPath, request.baseRef, request.targetRef);
  });

  registerHandler('changes:link', async (_event, raw) => {
    const request = await validateChangeLinkRequest(raw, authorizedRoots);
    const changed = await getChangedFiles(request.repoPath, request.baseRef, request.targetRef);
    return buildChangeLinks(request.repoPath, changed, request.elements);
  });

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopSidecar();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
