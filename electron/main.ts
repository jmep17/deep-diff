import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// Resolve a GitHub token WITHOUT persisting it, from env vars then the `gh` CLI.
// There is no UI token field — the token is never renderer-supplied or written
// to disk. Returns undefined for unauthenticated (public) requests.
let cachedGhToken: string | null | undefined;
async function resolveGitHubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim();
  if (cachedGhToken !== undefined) return cachedGhToken ?? undefined;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']);
    cachedGhToken = stdout.trim() || null;
  } catch {
    cachedGhToken = null;
  }
  return cachedGhToken ?? undefined;
}
import { buildChangeLinks, getChangedFiles } from './changeLink.js';
import { scanEndpoints } from './endpointScanner.js';
import {
  assertAuthorizedRepoPath,
  validateChangedFilesRequest,
  validateChangeLinkRequest,
  validateEndpointOverrides,
  validateGitHubBranchRequest,
  validateGitHubRepositoryRequest,
  validateLogAppend,
  validateLogReveal,
  validateSidecarLaunchRequest,
  validateVisualDiffRequest,
} from './ipcValidation.js';
import { logError, logInfo } from './logger.js';
import {
  fetchGitHubBranches,
  fetchGitHubRepositories,
  listLocalBranches,
  scanWorkspace,
} from './repositories.js';
import {
  appendSidecarConsole,
  discoveryBus,
  getSidecarStatus,
  launchSidecar,
  setSidecarOverrides,
  stopSidecar,
} from './sidecar.js';
import { runVisualDiff } from './visualDiff.js';
import { captureBus } from './mockCapture.js';
import { attachCaptureSink, registerCaptureScheme } from './captureSink.js';
import {
  deleteOverlayFile,
  ensureOverlayScaffold,
  listOverlayFiles,
  readOverlayFile,
  writeOverlayFile,
} from './repoOverlay.js';
import { getLogDir, logBus } from './serverLogs.js';
import type { RepositorySummary } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Capture preload (installs the network-capture interceptor in captured pages).
const CAPTURE_PRELOAD = path.join(__dirname, 'capture-preload.cjs');
// Register the capture scheme before the app `ready` event (privileges lock in at
// startup); the report sinks are attached per-session in whenReady / visualDiff.
registerCaptureScheme();

// Root for per-repo overlay folders: test-only files Deep Diff copies over a capture
// worktree (e.g. an auth-SDK mock alias). Overridable via env for tests/power users;
// otherwise lives under the app's userData. Resolved here in the main process so the
// core modules stay Electron-free and the renderer can't supply an arbitrary copy source.
function overlaysRoot() {
  return process.env.DEEP_DIFF_OVERLAY_ROOT ?? path.join(app.getPath('userData'), 'overlays');
}

// Persisted UI state (profiles, edited mock bodies, settings) lives in a single
// JSON file under userData. App-owned storage, not the user's repo — written
// atomically (tmp + rename) so a crash mid-write can't corrupt it.
function statePath() {
  return process.env.DEEP_DIFF_STATE_FILE ?? path.join(app.getPath('userData'), 'state.json');
}

// Validate a renderer-supplied overlay-relative path: a non-empty string, no NUL,
// not absolute. (`..` traversal is additionally rejected when resolved in repoOverlay.)
function overlayRelPath(raw: unknown): string {
  const rel = (raw as { relPath?: unknown })?.relPath;
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('Missing overlay file path.');
  if (rel.includes('\0') || path.isAbsolute(rel)) throw new Error('Invalid overlay file path.');
  return rel;
}

// Resolve (and scaffold + document) the repo's overlay folder. Overlays are opt-in
// convenience, so a scaffold failure must not break an otherwise-fine launch/diff —
// log and proceed without an overlay.
async function resolveOverlayDir(repoPath: string): Promise<string | undefined> {
  try {
    const dir = await ensureOverlayScaffold(overlaysRoot(), repoPath);
    logInfo('overlay:dir', `repo overlay folder: ${dir}`);
    return dir;
  } catch (err) {
    logError('overlay:scaffold', err);
    return undefined;
  }
}

// Workspace directories explicitly chosen by the user via the open-dialog this session.
// All repoPath values arriving over IPC must be at or under one of these roots.
const authorizedRoots = new Set<string>();

// Temp parent dirs holding clones of remote (GitHub) repos opened this session.
// Removed on quit. The clone runs exactly like a local repo afterward.
const tempClones = new Set<string>();

// Clone a remote GitHub repo to a temp dir, authorize it, and return a local
// RepositorySummary so the rest of the app (scan / sidecar / diff) treats it like
// any local repo. Uses resolveGitHubToken (env / `gh`) for private repos; the
// token is stripped from the clone's remote afterward so it is never persisted.
async function cloneAndOpenRemote(owner: string, repository: string): Promise<RepositorySummary> {
  const token = await resolveGitHubToken();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'deep-diff-clone-'));
  const repoDir = path.join(parent, repository);
  const publicUrl = `https://github.com/${owner}/${repository}.git`;
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${owner}/${repository}.git`
    : publicUrl;
  try {
    // --no-single-branch fetches every head; then materialize a local branch per
    // remote head so the worktree-based diff can check out non-default branches.
    await execFileAsync('git', ['clone', '--no-single-branch', cloneUrl, repoDir]);
    await execFileAsync('git', ['-C', repoDir, 'remote', 'set-url', 'origin', publicUrl]);
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoDir,
      'branch',
      '-r',
      '--format=%(refname:short)',
    ]);
    for (const ref of stdout.split('\n').map((s) => s.trim())) {
      if (!ref.startsWith('origin/') || ref.endsWith('/HEAD')) continue;
      const name = ref.slice('origin/'.length);
      await execFileAsync('git', ['-C', repoDir, 'branch', '--force', name, ref]).catch(
        () => undefined,
      );
    }
  } catch (err) {
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    throw err instanceof Error ? err : new Error(String(err));
  }
  const real = await fs.realpath(repoDir);
  authorizedRoots.add(real);
  tempClones.add(parent);
  const branches = await listLocalBranches(real);
  let defaultBranch = branches[0] ?? 'main';
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      real,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    defaultBranch = stdout.trim() || defaultBranch;
  } catch {
    /* keep fallback */
  }
  return {
    id: `clone:${owner}/${repository}`,
    name: repository,
    fullName: `${owner}/${repository}`,
    source: 'local',
    path: real,
    defaultBranch,
  };
}

function cleanupTempClones() {
  for (const dir of tempClones) {
    try {
      fsSync.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tempClones.clear();
}

// The primary app window. Tracked at module scope so the logBus subscription can
// stream captured server/page logs to it (and only it — never the hidden
// visual-diff capture window).
let activeWindow: BrowserWindow | undefined;

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

  activeWindow = mainWindow;
  mainWindow.on('closed', () => {
    if (activeWindow === mainWindow) activeWindow = undefined;
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
    // Force OUR capture preload (a main-process path, never renderer-supplied) so
    // the network-capture interceptor is installed in the preview page before its
    // first request. This replaces any renderer-set preload — the renderer still
    // cannot inject an arbitrary one.
    webPreferences.preload = CAPTURE_PRELOAD;
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
  // Persist run logs under userData so the in-app drawer and "Reveal" can find
  // them. getLogDir() falls back to os.tmpdir() for direct-call scripts.
  process.env.DEEP_DIFF_LOG_DIR ??= path.join(app.getPath('userData'), 'logs');

  // Stream every captured log line to the renderer's log drawer. Target the main
  // window only — getAllWindows() would also include the hidden visual-diff
  // capture window (the captured app's own renderer), which must not receive these.
  logBus.on('entry', (entry) => {
    if (activeWindow && !activeWindow.isDestroyed()) {
      activeWindow.webContents.send('logs:event', entry);
    }
  });

  // Stream endpoints discovered at runtime through the sidecar proxy so they join
  // the renderer's (mockable) inventory. Main window only, same rationale as above.
  discoveryBus.on('endpoint', (endpoint) => {
    if (activeWindow && !activeWindow.isDestroyed()) {
      activeWindow.webContents.send('endpoints:observed', endpoint);
    }
  });

  // Record the real response bodies the capture interceptor reports from the
  // sidecar preview <webview> (its dedicated partition session).
  attachCaptureSink(session.fromPartition('sidecar-preview'));

  // Endpoints first captured with a real body join the inventory like proxy-
  // discovered ones — same channel; the renderer merges and reapplies user edits.
  captureBus.on('endpoint', (endpoint) => {
    if (activeWindow && !activeWindow.isDestroyed()) {
      activeWindow.webContents.send('endpoints:observed', endpoint);
    }
  });

  // Dev/test seam: seed authorized roots and auto-open a workspace WITHOUT the
  // native folder dialog, so the GUI flow is driveable over CDP/agent-browser
  // (the macOS open panel runs in a separate process that automation can't reach,
  // and screenshot-filtering hides it). Inactive in normal use — only when the env
  // vars are set. Paths are still validated against authorizedRoots downstream.
  for (const root of (process.env.DEEP_DIFF_AUTHORIZE_ROOTS ?? '').split(path.delimiter)) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    try {
      authorizedRoots.add(await fs.realpath(trimmed));
    } catch {
      /* ignore an unresolvable seed path */
    }
  }

  registerHandler('workspace:seeded', async () => {
    const seed = process.env.DEEP_DIFF_WORKSPACE?.trim();
    if (!seed) return null;
    const realRoot = await fs.realpath(seed);
    authorizedRoots.add(realRoot);
    return scanWorkspace(seed);
  });

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

  registerHandler('github:listRepos', async (_event, raw) => {
    const request = validateGitHubRepositoryRequest(raw);
    return fetchGitHubRepositories({ ...request, token: await resolveGitHubToken() });
  });

  registerHandler('github:listBranches', async (_event, raw) => {
    const request = validateGitHubBranchRequest(raw);
    return fetchGitHubBranches({ ...request, token: await resolveGitHubToken() });
  });

  // Clone a remote repo to a temp dir and return it as a local, runnable repo.
  registerHandler('repo:cloneAndOpen', async (_event, raw) => {
    const request = validateGitHubBranchRequest(raw);
    return cloneAndOpenRemote(request.owner, request.repository);
  });

  registerHandler('sidecar:launch', async (_event, raw) => {
    const request = await validateSidecarLaunchRequest(raw, authorizedRoots);
    if (request.repoPath) {
      request.overlayDir = await resolveOverlayDir(request.repoPath);
    }
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
    request.overlayDir = await resolveOverlayDir(request.repoPath);
    return runVisualDiff(request);
  });

  // Resolve (creating + documenting) the repo's overlay folder, and optionally open it
  // in the OS file manager. Lets the renderer create the folder on repo-select and
  // reveal it on demand, instead of it only appearing buried in userData after a diff.
  registerHandler('overlay:folder', async (_event, raw) => {
    const repoPath = await assertAuthorizedRepoPath(
      (raw as { repoPath?: unknown })?.repoPath,
      authorizedRoots,
    );
    const dir = await ensureOverlayScaffold(overlaysRoot(), repoPath);
    if ((raw as { open?: unknown })?.open) {
      const err = await shell.openPath(dir);
      if (err) logError('overlay:open', err);
    }
    return dir;
  });

  // Overlay-folder file editing. The overlay folder is app-owned storage under
  // userData (not the user's repo); repoPath is validated against authorizedRoots
  // and the relative path is confined to that repo's overlay folder in repoOverlay.
  registerHandler('overlay:list', async (_event, raw) => {
    const repoPath = await assertAuthorizedRepoPath(
      (raw as { repoPath?: unknown })?.repoPath,
      authorizedRoots,
    );
    return listOverlayFiles(overlaysRoot(), repoPath);
  });

  registerHandler('overlay:readFile', async (_event, raw) => {
    const repoPath = await assertAuthorizedRepoPath(
      (raw as { repoPath?: unknown })?.repoPath,
      authorizedRoots,
    );
    return readOverlayFile(overlaysRoot(), repoPath, overlayRelPath(raw));
  });

  registerHandler('overlay:writeFile', async (_event, raw) => {
    const repoPath = await assertAuthorizedRepoPath(
      (raw as { repoPath?: unknown })?.repoPath,
      authorizedRoots,
    );
    const content = (raw as { content?: unknown })?.content;
    if (typeof content !== 'string') throw new Error('Overlay file content must be a string.');
    if (content.length > 2_000_000) throw new Error('Overlay file too large.');
    await writeOverlayFile(overlaysRoot(), repoPath, overlayRelPath(raw), content);
    return listOverlayFiles(overlaysRoot(), repoPath);
  });

  registerHandler('overlay:deleteFile', async (_event, raw) => {
    const repoPath = await assertAuthorizedRepoPath(
      (raw as { repoPath?: unknown })?.repoPath,
      authorizedRoots,
    );
    await deleteOverlayFile(overlaysRoot(), repoPath, overlayRelPath(raw));
    return listOverlayFiles(overlaysRoot(), repoPath);
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

  // Forward a browser-console message from the live sidecar preview <webview>
  // into the running sidecar's log (the preview page lives in the renderer, so
  // its console can't be captured in the main process like the diff's is).
  registerHandler('logs:append', (_event, raw) => {
    const { text, level } = validateLogAppend(raw);
    appendSidecarConsole(text, level);
  });

  // Reveal a run's log file in the OS file manager. Confined to our own log dir
  // (realpath containment) so a renderer-supplied path can't reveal anything else.
  registerHandler('logs:reveal', async (_event, raw) => {
    const file = validateLogReveal(raw);
    const realDir = await fs.realpath(getLogDir());
    let realFile: string;
    try {
      realFile = await fs.realpath(file);
    } catch {
      throw new Error('Log file no longer exists.');
    }
    if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) {
      throw new Error('Refusing to reveal a path outside the log directory.');
    }
    shell.showItemInFolder(realFile);
    return realFile;
  });

  // Load persisted UI state. Missing/corrupt file → empty object (first run).
  registerHandler('state:load', async () => {
    try {
      const raw = await fs.readFile(statePath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });

  // Persist UI state atomically. Payload must be a plain object and bounded in
  // size; it's app-owned data so no path/ref validation applies.
  registerHandler('state:save', async (_event, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid state payload.');
    }
    const json = JSON.stringify(raw);
    if (json.length > 5_000_000) throw new Error('State payload too large.');
    const file = statePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, file);
    return true;
  });

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('will-quit', cleanupTempClones);

app.on('window-all-closed', () => {
  stopSidecar();
  cleanupTempClones();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
