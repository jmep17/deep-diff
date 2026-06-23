import { BrowserWindow, nativeImage, net as electronNet } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  VisualDiffReport,
  VisualDiffRequest,
  VisualDiffRouteReport,
  VisualDiffViewport,
} from './types.js';
import { scanVisualRoutes, selectRoutes, type VisualRoute } from './routeDetection.js';
import { matchOverride, type EndpointOverrides } from './overrideMatcher.js';
import { clearCaptures, getCaptures } from './mockCapture.js';
import { attachCaptureSink } from './captureSink.js';
import { detectAuth0Config } from './authConfigDetector.js';
import { installDependencies, type PackageManager } from './installDependencies.js';
import { applyOverlay } from './repoOverlay.js';
import { attachConsoleCapture, LogSink, type LogServer } from './serverLogs.js';

const execFileAsync = promisify(execFile);

const workingTreeRef = '__working_tree__';
const defaultViewport: VisualDiffViewport = { width: 1280, height: 900 };
const diffThreshold = 18;

// Mirror of CONSOLE_PATCH_SCRIPT in src/App.tsx — JSON-stringify object console
// args before Chromium collapses them to "[object Object]". Kept in sync by hand;
// both the sidecar webview and this capture window use the same patch.
const CONSOLE_PATCH_SCRIPT = `(() => {
  if (window.__ddsConsolePatched) return;
  window.__ddsConsolePatched = true;
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    if (a === null || a === undefined || typeof a !== 'object') return String(a);
    try { return JSON.stringify(a, null, 2); } catch (_e) { return String(a); }
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[m];
    if (typeof orig !== 'function') continue;
    console[m] = (...args) => orig.apply(console, args.map(fmt));
  }
})();`;

function trace(message: string) {
  if (!process.env.DEEP_DISH_DIFF_TRACE) return;
  try {
    fsSync.appendFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'visual-diff.trace'),
      `${Date.now()} ${message}\n`,
    );
  } catch {
    // Ignore trace failures.
  }
}

interface RuntimeRepository {
  path: string;
  cleanup: () => Promise<void>;
}

interface RunningServer {
  ref: string;
  url: string;
  command: string;
  process: ChildProcessWithoutNullStreams;
  cleanup: () => Promise<void>;
}

interface CapturedPage {
  dataUrl: string;
  bitmap: Buffer;
  width: number;
  height: number;
}

async function pathExists(targetPath: string) {
  return fs.access(targetPath).then(
    () => true,
    () => false,
  );
}

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port);
        else reject(new Error('Unable to allocate a local port.'));
      });
    });
  });
}

function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('pnpm@')) return 'pnpm';
  if (value.startsWith('yarn@')) return 'yarn';
  if (value.startsWith('npm@')) return 'npm';
  return undefined;
}

async function inferPackageManager(
  repoPath: string,
  packageJson: { packageManager?: unknown },
): Promise<PackageManager> {
  const declaredPackageManager = packageManagerFromField(packageJson.packageManager);
  if (declaredPackageManager) return declaredPackageManager;
  if (await pathExists(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(repoPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function devCommand(packageManager: PackageManager, port: number) {
  return `${packageManager} run dev -- --host 127.0.0.1 --port ${port}`;
}

// Dev scripts that aren't named "dev" (e.g. "develop", "serve"). We can't know
// whether the script reads the --port/--host flags or the PORT env var, so we
// pass both: PORT covers frameworks that ignore CLI flags (Next), the flags
// cover those that ignore PORT (Vite). Setting an unused PORT env is harmless.
function namedDevCommand(packageManager: PackageManager, script: string, port: number) {
  return `PORT=${port} ${packageManager} run ${script} -- --host 127.0.0.1 --port ${port}`;
}

function startCommand(packageManager: PackageManager, port: number) {
  return `PORT=${port} ${packageManager} start`;
}

async function inferDevCommand(repoPath: string, port: number) {
  const packageJsonPath = path.join(repoPath, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  const packageManager = await inferPackageManager(repoPath, packageJson);

  if (scripts.dev) return devCommand(packageManager, port);
  if (scripts.develop) return namedDevCommand(packageManager, 'develop', port);
  if (scripts.serve) return namedDevCommand(packageManager, 'serve', port);
  if (scripts.start) return startCommand(packageManager, port);
  throw new Error('No dev, develop, serve, or start script was found in the selected repository.');
}

function safeName(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function displayRef(ref: string) {
  return ref === workingTreeRef ? 'Working tree' : ref;
}

async function prepareRuntimeRepository(
  repoPath: string,
  ref: string,
  overlayDir?: string,
  onInstallData?: (text: string) => void,
): Promise<RuntimeRepository> {
  if (ref === workingTreeRef) {
    return {
      path: repoPath,
      cleanup: async () => undefined,
    };
  }

  const worktreeRoot = path.join(os.tmpdir(), 'deep-diff-compare-worktrees');
  const worktreePath = path.join(
    worktreeRoot,
    `${safeName(path.basename(repoPath))}-${safeName(ref)}-${Date.now()}`,
  );
  await fs.mkdir(worktreeRoot, { recursive: true });
  await execFileAsync('git', [
    '-C',
    repoPath,
    'worktree',
    'add',
    '--force',
    '--detach',
    worktreePath,
    ref,
  ]);

  const cleanup = async () => {
    await execFileAsync('git', [
      '-C',
      repoPath,
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ]).catch(async () => {
      await fs.rm(worktreePath, { recursive: true, force: true });
    });
  };

  try {
    // Apply the repo's overlay files (e.g. an auth-SDK mock alias) onto the worktree
    // before install/spawn so config/dependency changes take effect. Whole-file copy;
    // applied identically to base and target worktrees, so control routes stay identical.
    const applied = await applyOverlay(worktreePath, overlayDir);
    if (applied.length > 0)
      trace(`overlay applied ${applied.length} file(s): ${applied.join(', ')}`);

    // A fresh worktree has no node_modules; install before the dev server is spawned.
    const packageJson = JSON.parse(
      await fs.readFile(path.join(worktreePath, 'package.json'), 'utf8'),
    );
    const packageManager: PackageManager = await inferPackageManager(worktreePath, packageJson);
    await installDependencies(worktreePath, packageManager, onInstallData);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    path: worktreePath,
    cleanup,
  };
}

async function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.killed) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function waitForHttpReady(
  url: string,
  child: ChildProcessWithoutNullStreams,
  sink: LogSink,
  server: LogServer,
  timeoutMs = 18_000,
) {
  const startedAt = Date.now();

  // Recent output for this server + a pointer to the full log file, so a server
  // that never comes up is debuggable from the failure message alone.
  const tail = () => {
    const lines = sink.entries
      .filter((e) => e.server === server)
      .slice(-4)
      .map((e) => e.text)
      .join('\n');
    return `${lines}\n(full log: ${sink.file})`;
  };

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      child.off('exit', onExit);
    };

    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };

    const onExit = () => {
      if (!settled) {
        fail(`Server for ${url} exited before it was ready.\n${tail()}`);
      }
    };

    const attempt = () => {
      if (settled) return;

      if (Date.now() - startedAt > timeoutMs) {
        fail(`Timed out waiting for ${url}.\n${tail()}`);
        return;
      }

      const request = http.get(url, (response) => {
        response.resume();
        cleanup();
        resolve();
      });

      request.once('error', () => {
        setTimeout(attempt, 300);
      });
      request.setTimeout(900, () => {
        request.destroy();
        setTimeout(attempt, 300);
      });
    };

    child.once('exit', onExit);
    attempt();
  });
}

async function startServer(
  repoPath: string,
  ref: string,
  role: LogServer,
  sink: LogSink,
  commandOverride?: string,
  overlayDir?: string,
): Promise<RunningServer> {
  trace(`startServer begin ${ref}`);
  const runtime = await prepareRuntimeRepository(repoPath, ref, overlayDir, (text) =>
    sink.append(role, 'install', text),
  );
  trace(`startServer runtime ${runtime.path}`);
  const port = await getFreePort();
  const command = commandOverride?.trim() || (await inferDevCommand(runtime.path, port));
  trace(`startServer command ${command}`);

  const auth0Env = (await detectAuth0Config(runtime.path))
    ? { AUTH0_BASE_URL: `http://localhost:${port}`, APP_BASE_URL: `http://localhost:${port}` }
    : {};

  sink.system(role, `launching: ${command} (port ${port}, ref ${displayRef(ref)})`);

  const child = spawn(command, {
    cwd: runtime.path,
    env: {
      ...process.env,
      PORT: String(port),
      VITE_PORT: String(port),
      DEEP_DISH_DIFF_BRANCH: displayRef(ref),
      ...auth0Env,
    },
    shell: true,
  });

  // Capture the dev server's full terminal output, tagged with its role (base /
  // target). `shell:true` keeps the grandchild (node server.mjs) output flowing
  // through these piped streams.
  child.stdout.on('data', (chunk: Buffer) => sink.append(role, 'stdout', chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => sink.append(role, 'stderr', chunk.toString('utf8')));
  child.once('exit', (code) => sink.system(role, `process exited (code ${code ?? 'null'})`));

  const url = `http://127.0.0.1:${port}`;

  try {
    await waitForHttpReady(url, child, sink, role);
    sink.system(role, `server ready ${url}`);
    trace(`startServer ready ${url}`);
  } catch (error) {
    await stopProcess(child);
    await runtime.cleanup();
    throw error;
  }

  return {
    ref,
    url,
    command,
    process: child,
    cleanup: async () => {
      trace('stop child');
      await stopProcess(child);
      trace('remove worktree');
      await runtime.cleanup();
      trace('server cleanup done');
    },
  };
}

function asDataUrl(buffer: Buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

// Which server the capture window is currently loading, so the page's browser
// console messages can be attributed to base vs target. Runs are serial, so a
// single module-level value is sufficient; capturePage sets it before each load.
let currentCaptureServer: LogServer = 'base';

async function capturePage(
  window: BrowserWindow,
  baseUrl: string,
  route: VisualRoute,
  viewport: VisualDiffViewport,
  server: LogServer,
): Promise<CapturedPage> {
  // Attribute any browser-console messages this load emits to the right server.
  currentCaptureServer = server;

  if (
    window.getBounds().width !== viewport.width ||
    window.getBounds().height !== viewport.height
  ) {
    window.setSize(viewport.width, viewport.height);
  }

  await window.loadURL(new URL(route.urlPath, baseUrl).toString());
  await new Promise((resolve) => setTimeout(resolve, 250));

  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  const png = image.toPNG({ scaleFactor: 1 });

  return {
    dataUrl: asDataUrl(png),
    bitmap,
    width: size.width,
    height: size.height,
  };
}

/**
 * Load each route once on the BASE server (no mocks, real passthrough) so the
 * injected capture interceptor records real response bodies BEFORE the
 * base/target comparison. No screenshot; a slightly longer settle than
 * capturePage lets async fetch/XHR calls complete and report.
 */
async function preflightCaptureRoutes(
  window: BrowserWindow,
  baseUrl: string,
  routes: VisualRoute[],
): Promise<void> {
  for (const route of routes) {
    try {
      currentCaptureServer = 'base';
      await window.loadURL(new URL(route.urlPath, baseUrl).toString());
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch {
      /* a route that fails to load just yields no captures for it */
    }
  }
}

// Resolved relative to the compiled visualDiff.js in dist-electron/.
const CAPTURE_PRELOAD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'capture-preload.cjs',
);

function createCaptureWindow(viewport: VisualDiffViewport) {
  const window = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      // Dedicated, in-memory partition so the http interception in runVisualDiff
      // (session.protocol.handle) is scoped to THIS window's session and never
      // touches the app's default session or the main window's network.
      partition: 'visual-diff-capture',
      // Installs the network-capture interceptor in the page main world at
      // document-start (sandbox-safe — it only injects a <script> + reads DOM).
      preload: CAPTURE_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // Untrusted target-repo pages render here; keep them OS-sandboxed so a
      // Chromium exploit in captured content is contained.
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Captured pages are untrusted repo output — never let them spawn windows.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}

function buildDiffImage(before: CapturedPage, after: CapturedPage) {
  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);
  const pixelCount = width * height;
  // Each bitmap may have a different row stride when captures differ in size or
  // when HiDPI scaling produces a wider actual bitmap than the logical viewport.
  // Using each bitmap's own stride prevents misaligned pixel reads.
  const beforeBytesPerRow = before.width * 4;
  const afterBytesPerRow = after.width * 4;
  const diffBytesPerRow = width * 4;
  const diffBitmap = Buffer.alloc(pixelCount * 4);
  let mismatchPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const beforeOffset = y * beforeBytesPerRow + x * 4;
      const afterOffset = y * afterBytesPerRow + x * 4;
      const diffOffset = y * diffBytesPerRow + x * 4;
      const delta =
        Math.abs(before.bitmap[beforeOffset] - after.bitmap[afterOffset]) +
        Math.abs(before.bitmap[beforeOffset + 1] - after.bitmap[afterOffset + 1]) +
        Math.abs(before.bitmap[beforeOffset + 2] - after.bitmap[afterOffset + 2]);

      if (delta > diffThreshold) {
        mismatchPixels += 1;
        diffBitmap[diffOffset] = 48;
        diffBitmap[diffOffset + 1] = 52;
        diffBitmap[diffOffset + 2] = 225;
        diffBitmap[diffOffset + 3] = 255;
        continue;
      }

      const gray = Math.round(
        after.bitmap[afterOffset] * 0.11 +
          after.bitmap[afterOffset + 1] * 0.59 +
          after.bitmap[afterOffset + 2] * 0.3,
      );
      diffBitmap[diffOffset] = gray;
      diffBitmap[diffOffset + 1] = gray;
      diffBitmap[diffOffset + 2] = gray;
      diffBitmap[diffOffset + 3] = 255;
    }
  }

  const diffImage = nativeImage.createFromBitmap(diffBitmap, { width, height, scaleFactor: 1 });

  return {
    mismatchPixels,
    mismatchRatio: pixelCount > 0 ? mismatchPixels / pixelCount : 0,
    diffImage: asDataUrl(diffImage.toPNG({ scaleFactor: 1 })),
    sizeMismatch: before.width !== after.width || before.height !== after.height,
  };
}

export async function runVisualDiff(request: VisualDiffRequest): Promise<VisualDiffReport> {
  trace('runVisualDiff begin');
  const startedAt = Date.now();
  const runId = Date.now().toString();
  // One log file per run; both dev servers and the captured pages write into it,
  // each line tagged [base] / [target]. The file is the durable full record; the
  // returned `logs` snapshot is bounded.
  const sink = new LogSink(runId, 'diff', `diff-${runId}.log`);
  const viewport = request.viewport ?? defaultViewport;
  // Fresh capture buffer per run; the pre-flight below fills it with real bodies.
  clearCaptures();

  let baseServer: RunningServer | undefined;
  let targetServer: RunningServer | undefined;

  try {
    const allRoutes = await scanVisualRoutes(request.repoPath);
    trace(`runVisualDiff routes scanned ${allRoutes.length}`);
    const routes = selectRoutes(allRoutes, request.routes);
    trace(`runVisualDiff routes selected ${routes.length}`);
    baseServer = await startServer(
      request.repoPath,
      request.baseRef,
      'base',
      sink,
      request.command,
      request.overlayDir,
    );
    targetServer = await startServer(
      request.repoPath,
      request.targetRef,
      'target',
      sink,
      request.command,
      request.overlayDir,
    );
    const base = baseServer;
    const target = targetServer;
    trace('runVisualDiff servers ready');
    const routeReports: VisualDiffRouteReport[] = [];
    const captureWindow = createCaptureWindow(viewport);
    // Record real response bodies the injected interceptor reports (from the
    // pre-flight and from each rendered page) into the capture buffer.
    attachCaptureSink(captureWindow.webContents.session);

    // Capture the rendered page's browser console (JS errors, failed fetches) —
    // the failure mode where the server returns 200 but the page is blank/broken.
    attachConsoleCapture(captureWindow.webContents, () => currentCaptureServer, sink);
    // Patch the captured page's console so object args are JSON-stringified before
    // Chromium collapses them to "[object Object]". Mirrors CONSOLE_PATCH_SCRIPT in
    // src/App.tsx (the sidecar webview path); both runtime paths get the same fix.
    captureWindow.webContents.on('dom-ready', () => {
      captureWindow.webContents.executeJavaScript(CONSOLE_PATCH_SCRIPT).catch(() => undefined);
    });

    // Capture pre-flight: load each route on the BASE server with NO mocks so the
    // injected interceptor records real response bodies BEFORE the comparison.
    // This is what lets the very first (cold) diff render with real data.
    await preflightCaptureRoutes(captureWindow, base.url, routes);

    // Freeze the override set served identically to BOTH sides (the determinism
    // invariant: base and target get byte-identical responses per call).
    // Precedence: a user-edited mock (userMockKeys) wins; else a freshly-captured
    // REAL body wins over the request's (possibly synthetic) body; else the
    // request body fills in.
    const captured = getCaptures();
    const capturedCount = Object.keys(captured).length;
    // Make a silent capture no-op visible (CSP block, no same-doc JSON calls, …)
    // rather than letting it masquerade as success behind synthetic fallbacks.
    sink.append(
      'base',
      'system',
      capturedCount > 0
        ? `capture: recorded ${capturedCount} real API ${capturedCount === 1 ? 'body' : 'bodies'} during pre-flight`
        : 'capture: no real API bodies recorded during pre-flight — falling back to synthetic mocks',
    );
    const requestOverrides = request.endpointOverrides ?? {};
    const userKeys = new Set(request.userMockKeys ?? []);
    const overrides: EndpointOverrides = { ...captured };
    for (const [key, body] of Object.entries(requestOverrides)) {
      if (userKeys.has(key) || !(key in overrides)) overrides[key] = body;
    }

    // Serve the frozen overrides via session-level HTTP interception. Gated on a
    // non-empty set so a genuine no-mock run stays byte-for-byte unchanged.
    // bypassCustomProtocolHandlers:true on the passthrough is mandatory — without
    // it net.fetch re-enters this handler and hangs the diff.
    const interceptionActive = Object.keys(overrides).length > 0;
    const ses = captureWindow.webContents.session;
    if (interceptionActive) {
      ses.protocol.handle('http', async (req) => {
        const pathname = new URL(req.url).pathname;
        const mocked = matchOverride(overrides, req.method, pathname);
        if (mocked !== undefined) {
          sink.append(currentCaptureServer, 'network', `${req.method} ${pathname} → 200 (mock)`);
          return new Response(JSON.stringify(mocked), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const res = await electronNet.fetch(req, { bypassCustomProtocolHandlers: true });
        // Log only API-ish passthroughs to avoid drowning the log in asset loads.
        if (pathname.startsWith('/api') || pathname.includes('/api/')) {
          sink.append(
            currentCaptureServer,
            'network',
            `${req.method} ${pathname} → ${res.status} (server)`,
          );
        }
        return res;
      });
    }

    try {
      for (const route of routes) {
        try {
          trace(`capture begin ${route.path}`);
          const before = await capturePage(captureWindow, base.url, route, viewport, 'base');
          const after = await capturePage(captureWindow, target.url, route, viewport, 'target');
          const diff = buildDiffImage(before, after);
          trace(`capture done ${route.path}`);

          const tolerance = request.mismatchTolerance ?? 0;
          routeReports.push({
            id: `${route.path}:${Date.now()}`,
            path: route.path,
            urlPath: route.urlPath,
            status: diff.mismatchRatio > tolerance ? 'failed' : 'passed',
            mismatchPixels: diff.mismatchPixels,
            mismatchRatio: diff.mismatchRatio,
            beforeImage: before.dataUrl,
            afterImage: after.dataUrl,
            diffImage: diff.diffImage,
          });
        } catch (error) {
          routeReports.push({
            id: `${route.path}:error:${Date.now()}`,
            path: route.path,
            urlPath: route.urlPath,
            status: 'error',
            mismatchPixels: 0,
            mismatchRatio: 0,
            beforeImage: '',
            afterImage: '',
            diffImage: '',
            error: error instanceof Error ? error.message : 'Route capture failed.',
          });
        }
      }
    } finally {
      if (interceptionActive) ses.protocol.unhandle('http');
      trace('destroy capture window');
      captureWindow.destroy();
    }

    const changedRoutes = routeReports.filter((route) => route.status === 'failed').length;
    trace(`runVisualDiff complete ${changedRoutes}/${routeReports.length}`);

    return {
      id: `report-${Date.now()}`,
      repoPath: request.repoPath,
      baseRef: displayRef(request.baseRef),
      targetRef: displayRef(request.targetRef),
      baseUrl: base.url,
      targetUrl: target.url,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      viewport,
      routes: routeReports,
      changedRoutes,
      totalRoutes: routeReports.length,
      logFile: sink.file,
      logs: sink.snapshot(),
    };
  } catch (error) {
    // Surface the captured output: a server that never came up is the main
    // failure, and waitForHttpReady already appends the log path to its message —
    // only add it here if it isn't already present.
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && message.includes(sink.file)) throw error;
    throw new Error(`${message}\n(full log: ${sink.file})`, { cause: error });
  } finally {
    trace('cleanup servers begin');
    void targetServer?.cleanup().catch(() => undefined);
    void baseServer?.cleanup().catch(() => undefined);
    sink.close();
    trace('cleanup servers scheduled');
  }
}

export { workingTreeRef };
