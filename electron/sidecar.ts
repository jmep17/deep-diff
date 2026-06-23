import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matchOverride, type EndpointOverrides } from './overrideMatcher.js';
import { detectAuth0Config } from './authConfigDetector.js';
import { installDependencies, type PackageManager } from './installDependencies.js';
import { applyOverlay } from './repoOverlay.js';
import { logInfo } from './logger.js';
import { LogSink } from './serverLogs.js';
import type { SidecarLaunchRequest, SidecarStatus } from './types.js';

const execFileAsync = promisify(execFile);

let sidecarProcess: ChildProcessWithoutNullStreams | undefined;
let status: SidecarStatus = { running: false };
let cleanupWorktree: (() => Promise<void>) | undefined;
let proxyServer: http.Server | undefined;
// Live, mutable override map the running proxy reads on every request. Kept as
// module state (not closed over at launch) so `setSidecarOverrides` can swap it
// in place — that is what lets a toggle take effect without relaunching.
let currentOverrides: EndpointOverrides = {};
// Captures the live sidecar's stdout/stderr + dependency install output, plus the
// preview page's browser console (forwarded from the renderer webview via
// appendSidecarConsole). Created per launch; closed and cleared on process exit.
let logSink: LogSink | undefined;

function startProxyServer(
  targetPort: number,
  getOverrides: () => EndpointOverrides,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const method = req.method ?? 'GET';
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const mockBody = matchOverride(getOverrides(), method, pathname);

      if (mockBody !== undefined) {
        const json = JSON.stringify(mockBody);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
        return;
      }

      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        },
      );

      proxyReq.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
      });

      req.pipe(proxyReq, { end: true });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) {
        resolve({ server, port: address.port });
      } else {
        reject(new Error('Unable to allocate proxy port.'));
      }
    });
  });
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

async function fileExists(filePath: string) {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
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

  if (await fileExists(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(path.join(repoPath, 'yarn.lock'))) return 'yarn';
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

async function prepareRuntimeRepository(
  repoPath: string,
  branch?: string,
  overlayDir?: string,
  onInstallData?: (text: string) => void,
) {
  if (!branch) {
    return repoPath;
  }

  const currentBranch = await execFileAsync('git', [
    '-C',
    repoPath,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');

  if (currentBranch === branch) {
    return repoPath;
  }

  const worktreeRoot = path.join(os.tmpdir(), 'deep-diff-worktrees');
  const worktreePath = path.join(
    worktreeRoot,
    `${safeName(path.basename(repoPath))}-${safeName(branch)}-${Date.now()}`,
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
    branch,
  ]);

  cleanupWorktree = async () => {
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
    cleanupWorktree = undefined;
  };

  try {
    // Apply the repo's overlay files (e.g. a vite.config that aliases an auth SDK to a
    // mock) onto the worktree before install/spawn, so dependency and dev-server config
    // changes take effect. Overlay is whole-file; only worktrees ever receive it.
    const applied = await applyOverlay(worktreePath, overlayDir);
    if (applied.length > 0) {
      logInfo(
        'sidecar:overlay',
        `applied ${applied.length} file(s) to ${worktreePath}: ${applied.join(', ')}`,
      );
    }

    // A fresh worktree has no node_modules; install before the dev server is spawned.
    const packageJson = JSON.parse(
      await fs.readFile(path.join(worktreePath, 'package.json'), 'utf8'),
    );
    const packageManager: PackageManager = await inferPackageManager(worktreePath, packageJson);
    await installDependencies(worktreePath, packageManager, onInstallData);
  } catch (error) {
    await cleanupWorktree?.();
    throw error;
  }

  return worktreePath;
}

export function getSidecarStatus() {
  return status;
}

export async function launchSidecar(request: SidecarLaunchRequest) {
  if (sidecarProcess && !sidecarProcess.killed) {
    return status;
  }

  if (!request.repoPath) {
    throw new Error('A local repository path is required to launch a sidecar server.');
  }

  const port = await getFreePort();
  const runId = Date.now().toString();
  logSink = new LogSink(runId, 'sidecar', `sidecar-${runId}.log`);
  const sink = logSink;

  try {
    const runtimeRepoPath = await prepareRuntimeRepository(
      request.repoPath,
      request.branch,
      request.overlayDir,
      (text) => sink.append('sidecar', 'install', text),
    );
    const command = request.command?.trim() || (await inferDevCommand(runtimeRepoPath, port));

    const auth0Env = (await detectAuth0Config(runtimeRepoPath))
      ? { AUTH0_BASE_URL: `http://localhost:${port}`, APP_BASE_URL: `http://localhost:${port}` }
      : {};

    sink.system(
      'sidecar',
      `launching: ${command} (port ${port}, ref ${request.branch ?? 'current'})`,
    );

    sidecarProcess = spawn(command, {
      cwd: runtimeRepoPath,
      env: {
        ...process.env,
        PORT: String(port),
        VITE_PORT: String(port),
        DEEP_DISH_DIFF_BRANCH: request.branch ?? '',
        ...auth0Env,
      },
      shell: true,
    });

    // Capture the dev server's full terminal output. `shell:true` keeps the
    // grandchild (node server.mjs) output flowing through these piped streams.
    sidecarProcess.stdout.on('data', (chunk: Buffer) =>
      sink.append('sidecar', 'stdout', chunk.toString('utf8')),
    );
    sidecarProcess.stderr.on('data', (chunk: Buffer) =>
      sink.append('sidecar', 'stderr', chunk.toString('utf8')),
    );

    currentOverrides = request.endpointOverrides ?? {};
    const hasOverrides = Object.keys(currentOverrides).length > 0;

    let exposedUrl = `http://127.0.0.1:${port}`;
    if (hasOverrides) {
      const proxy = await startProxyServer(port, () => currentOverrides);
      proxyServer = proxy.server;
      exposedUrl = `http://127.0.0.1:${proxy.port}`;
    }

    status = {
      running: true,
      url: exposedUrl,
      port,
      pid: sidecarProcess.pid,
      command,
      startedAt: new Date().toISOString(),
      logFile: sink.file,
    };

    sidecarProcess.once('exit', (code) => {
      sink.system('sidecar', `process exited (code ${code ?? 'null'})`);
      sink.close();
      if (logSink === sink) logSink = undefined;
      sidecarProcess = undefined;
      status = { running: false };
      proxyServer?.close();
      proxyServer = undefined;
      currentOverrides = {};
      void cleanupWorktree?.();
    });

    return status;
  } catch (error) {
    // Launch failed (worktree/install/spawn). The captured output is the most
    // useful thing here — flush it and point the caller at the log file.
    const message = error instanceof Error ? error.message : String(error);
    sink.system('sidecar', `launch failed: ${message}`);
    sink.close();
    if (logSink === sink) logSink = undefined;
    throw new Error(`${message} (logs: ${sink.file})`, { cause: error });
  }
}

/**
 * Append a browser-console message from the live sidecar preview page into the
 * current launch's log. Called by the `logs:append` IPC handler, which receives
 * console events from the renderer `<webview>` (the preview page lives in the
 * renderer, not the main process, so its console can't be captured here directly).
 * A no-op when no sidecar is running.
 */
export function appendSidecarConsole(text: string, level?: string): void {
  logSink?.append('sidecar', 'console', text, level);
}

/**
 * Applies a new endpoint-override map to the ALREADY-RUNNING sidecar, without a
 * relaunch. The proxy reads `currentOverrides` live on every request (see
 * `startProxyServer`), so swapping it in place takes effect on the next fetch.
 *
 * If the sidecar was launched without overrides (raw server, no proxy) and the
 * first override is now being applied, a proxy is brought up in front of the
 * real server and `status.url` is repointed to it — the renderer then points
 * the <webview> at the returned proxy URL. Once a proxy exists it is kept for
 * the rest of the run: an empty map just makes every request pass through,
 * which is how a mock is turned back "off" (the real response is restored).
 */
export async function setSidecarOverrides(overrides: EndpointOverrides) {
  if (!sidecarProcess || sidecarProcess.killed || !status.running) {
    throw new Error('No sidecar is running to apply mock overrides to.');
  }

  currentOverrides = overrides ?? {};
  const hasOverrides = Object.keys(currentOverrides).length > 0;

  if (!proxyServer && hasOverrides) {
    if (status.port === undefined) {
      throw new Error('Sidecar port is unknown; cannot start the mock proxy.');
    }
    const proxy = await startProxyServer(status.port, () => currentOverrides);
    proxyServer = proxy.server;
    status = { ...status, url: `http://127.0.0.1:${proxy.port}` };
  }

  return status;
}

export function stopSidecar() {
  if (sidecarProcess && !sidecarProcess.killed) {
    sidecarProcess.kill();
  }

  sidecarProcess = undefined;
  proxyServer?.close();
  proxyServer = undefined;
  currentOverrides = {};
  status = { running: false };
  return status;
}
