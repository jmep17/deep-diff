import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEndpoints } from './endpointScanner.js';
import {
  assertAuthorizedRepoPath,
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
import { getSidecarStatus, launchSidecar, stopSidecar } from './sidecar.js';
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

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: 'Deep Dish Diff',
    backgroundColor: '#faf3e6',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
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

  registerHandler('diff:run', async (_event, raw) => {
    const request = await validateVisualDiffRequest(raw, authorizedRoots);
    return runVisualDiff(request);
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
