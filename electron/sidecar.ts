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
import type { SidecarLaunchRequest, SidecarStatus } from './types.js';

const execFileAsync = promisify(execFile);

let sidecarProcess: ChildProcessWithoutNullStreams | undefined;
let status: SidecarStatus = { running: false };
let cleanupWorktree: (() => Promise<void>) | undefined;
let proxyServer: http.Server | undefined;

type PackageManager = 'npm' | 'pnpm' | 'yarn';

function startProxyServer(
  targetPort: number,
  overrides: EndpointOverrides,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const method = req.method ?? 'GET';
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const mockBody = matchOverride(overrides, method, pathname);

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

function startCommand(packageManager: PackageManager, port: number) {
  return `PORT=${port} ${packageManager} start`;
}

async function inferDevCommand(repoPath: string, port: number) {
  const packageJsonPath = path.join(repoPath, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  const packageManager = await inferPackageManager(repoPath, packageJson);

  if (scripts.dev) return devCommand(packageManager, port);
  if (scripts.start) return startCommand(packageManager, port);
  throw new Error('No dev or start script was found in the selected repository.');
}

function safeName(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

async function prepareRuntimeRepository(repoPath: string, branch?: string) {
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

  const worktreeRoot = path.join(os.tmpdir(), 'deep-dish-diff-worktrees');
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
  const runtimeRepoPath = await prepareRuntimeRepository(request.repoPath, request.branch);
  const command = request.command?.trim() || (await inferDevCommand(runtimeRepoPath, port));

  const auth0Env = (await detectAuth0Config(runtimeRepoPath))
    ? { AUTH0_BASE_URL: `http://localhost:${port}`, APP_BASE_URL: `http://localhost:${port}` }
    : {};

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

  const overrides = request.endpointOverrides;
  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;

  let exposedUrl = `http://127.0.0.1:${port}`;
  if (hasOverrides) {
    const proxy = await startProxyServer(port, overrides!);
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
  };

  sidecarProcess.once('exit', () => {
    sidecarProcess = undefined;
    status = { running: false };
    proxyServer?.close();
    proxyServer = undefined;
    void cleanupWorktree?.();
  });

  return status;
}

export function stopSidecar() {
  if (sidecarProcess && !sidecarProcess.killed) {
    sidecarProcess.kill();
  }

  sidecarProcess = undefined;
  proxyServer?.close();
  proxyServer = undefined;
  status = { running: false };
  return status;
}
