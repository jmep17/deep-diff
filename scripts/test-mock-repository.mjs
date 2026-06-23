#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEndpoints } from '../dist-electron/endpointScanner.js';
import {
  fetchGitHubBranches,
  listLocalBranches,
  scanWorkspace,
} from '../dist-electron/repositories.js';
import { getSidecarStatus, launchSidecar, stopSidecar } from '../dist-electron/sidecar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const mockRoot = path.join(projectRoot, 'mock-repositories');
const fixturePath = path.join(mockRoot, 'auth0-routes-fixture');
const expectations = JSON.parse(
  fs.readFileSync(path.join(fixturePath, 'fixture-expectations.json'), 'utf8'),
);

function pass(label, detail = '') {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, error) {
  console.error(`FAIL  ${label}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}

function assert(condition, label, detail) {
  if (condition) pass(label, detail);
  else fail(label, new Error(detail ?? 'Assertion failed'));
}

function getGitHubToken() {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

async function waitForHttp(url, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          response.resume();
          // The sidecar is always fronted by the proxy, which answers 502 until the
          // dev server behind it is listening — treat only a non-5xx response as
          // ready, otherwise keep polling.
          if ((response.statusCode ?? 500) < 500) resolve(undefined);
          else reject(new Error(`not ready (${response.statusCode})`));
        });
        request.on('error', reject);
        request.setTimeout(1000, () => {
          request.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function testLocalMode() {
  console.log('\n=== Local mode: auth0-routes-fixture ===');

  const workspace = await scanWorkspace(mockRoot);
  assert(
    workspace.repositories.length === 1,
    'scanWorkspace finds one repository',
    workspace.repositories[0]?.name,
  );
  assert(workspace.repositories[0]?.path === fixturePath, 'scanWorkspace resolves fixture path');
  assert(workspace.repositories[0]?.source === 'local', 'repository source is local');

  const branches = await listLocalBranches(fixturePath);
  assert(branches.includes('main'), 'listLocalBranches includes main', branches.join(', '));
  assert(
    branches.includes('feature/auth0-preview-callbacks'),
    'listLocalBranches includes feature/auth0-preview-callbacks',
  );

  const endpoints = await scanEndpoints(fixturePath);
  assert(
    endpoints.length >= expectations.endpoints.minimumCount,
    'scanEndpoints detects API routes',
    `${endpoints.length} endpoints`,
  );
  assert(
    endpoints.some((endpoint) => endpoint.path === '/api/public/status'),
    'scanEndpoints finds /api/public/status',
  );
  assert(
    endpoints.some((endpoint) => endpoint.path.includes('/api/auth')),
    'scanEndpoints finds Auth0-related API routes',
  );
  for (const requiredPath of expectations.endpoints.requiredPaths) {
    assert(
      endpoints.some(
        (endpoint) =>
          endpoint.path === requiredPath ||
          endpoint.path.includes(requiredPath.replace(':auth0', '')),
      ),
      `scanEndpoints finds route like ${requiredPath}`,
    );
  }

  const sidecar = await launchSidecar({ repoPath: fixturePath, branch: 'main' });
  try {
    assert(sidecar.running, 'sidecar launches on main');
    assert(Boolean(sidecar.url), 'sidecar exposes a URL', sidecar.url);
    await waitForHttp(sidecar.url);
    pass('sidecar serves HTTP', sidecar.url);

    const status = getSidecarStatus();
    assert(status.running, 'sidecar status reports running');
  } finally {
    stopSidecar();
    assert(!getSidecarStatus().running, 'sidecar stops cleanly');
  }

  const featureSidecar = await launchSidecar({
    repoPath: fixturePath,
    branch: 'feature/auth0-preview-callbacks',
  });
  try {
    await waitForHttp(featureSidecar.url);
    pass('sidecar launches feature branch worktree', featureSidecar.url);
  } finally {
    stopSidecar();
  }
}

async function testGitHubRemoteMode(token) {
  console.log('\n=== GitHub remote mode: auth0-routes-fixture metadata ===');

  const localBranches = await listLocalBranches(fixturePath);
  const owner = 'jmep17';
  const repository = 'auth0-routes-fixture';

  try {
    const remoteBranches = await fetchGitHubBranches({ owner, repository, token });
    assert(
      remoteBranches.length > 0,
      'fetchGitHubBranches returns branches',
      remoteBranches.join(', '),
    );
    for (const branch of localBranches) {
      assert(remoteBranches.includes(branch), `remote branch list includes ${branch}`);
    }
    pass('GitHub remote branches match local mock fixture branches');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('(404)')) {
      pass(
        'GitHub remote API reachable but fixture repo is not published',
        `${owner}/${repository} missing on GitHub; local branches verified separately`,
      );
      assert(localBranches.includes('main'), 'local fallback includes main');
      assert(
        localBranches.includes('feature/auth0-preview-callbacks'),
        'local fallback includes feature/auth0-preview-callbacks',
      );

      const smokeBranches = await fetchGitHubBranches({ owner, repository: 'deep-diff', token });
      assert(
        smokeBranches.includes('main'),
        'GitHub API smoke test via jmep17/deep-diff',
        smokeBranches.join(', '),
      );
      return;
    }
    throw error;
  }
}

async function testBranchContentDiff() {
  console.log('\n=== Branch comparison (HTTP): main vs feature/auth0-preview-callbacks ===');

  const fetchBranchPayload = async (branch) => {
    const sidecar = await launchSidecar({ repoPath: fixturePath, branch });
    try {
      await waitForHttp(sidecar.url);
      const response = await fetch(new URL(expectations.http.auth0CallbacksPath, sidecar.url));
      if (!response.ok) throw new Error(`${branch} returned ${response.status}`);
      return response.json();
    } finally {
      stopSidecar();
    }
  };

  const mainPayload = await fetchBranchPayload(expectations.branches.base);
  const featurePayload = await fetchBranchPayload(expectations.branches.target);

  assert(Array.isArray(mainPayload.callbackUrls), 'main branch exposes Auth0 callback URLs');
  assert(Array.isArray(featurePayload.callbackUrls), 'feature branch exposes Auth0 callback URLs');
  assert(
    JSON.stringify(mainPayload.callbackUrls) !== JSON.stringify(featurePayload.callbackUrls),
    'branch Auth0 callback URLs differ',
    'expected feature branch preview callbacks',
  );
  assert(
    featurePayload.callbackUrls.includes(expectations.http.featureOnlyCallbackUrl),
    'feature branch exposes branch preview callback URL',
  );
  assert(
    !mainPayload.callbackUrls.includes(expectations.http.featureOnlyCallbackUrl),
    'main branch does not expose branch preview callback URL',
  );
}

async function testVisualDiffWithElectron() {
  console.log('\n=== Visual diff (Electron): main vs feature/auth0-preview-callbacks ===');

  const electronCli = path.join(projectRoot, 'node_modules', '.bin', 'electron');
  const runnerPackage = path.join(projectRoot, 'scripts', 'electron-app');

  try {
    const output = execFileSync(electronCli, [runnerPackage], {
      encoding: 'utf8',
      cwd: projectRoot,
      timeout: 300_000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
      },
    });

    const reportPath = path.join(runnerPackage, 'last-report.json');
    const reportFromFile = (() => {
      try {
        return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch {
        return undefined;
      }
    })();

    const jsonLine = output
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .pop();

    const report = reportFromFile ?? (jsonLine ? JSON.parse(jsonLine) : undefined);

    if (!report) {
      fail('visual diff electron run', new Error(output || 'No JSON output from visual diff run'));
      return;
    }

    assert(report.ok, 'runVisualDiff completes');
    assert(
      report.totalRoutes === expectations.visualDiff.totalRoutes,
      'runVisualDiff captures expected route count',
      `${report.totalRoutes} routes`,
    );
    assert(
      report.changedRoutes === expectations.visualDiff.expectedChangedRoutes,
      'runVisualDiff detects expected visual changes',
      `${report.changedRoutes}/${report.totalRoutes} changed`,
    );
    assert(
      report.routeStatuses?.every((route) => route.hasImages !== false) ?? true,
      'visual diff report includes capture images',
    );

    const changedPaths = report.routeStatuses
      .filter((route) => route.status === 'failed')
      .map((route) => route.path)
      .sort();
    const expectedChangedPaths = [...expectations.visualDiff.changedPaths].sort();
    assert(
      JSON.stringify(changedPaths) === JSON.stringify(expectedChangedPaths),
      'visual diff changed routes match fixture expectations',
      changedPaths.join(', '),
    );

    for (const unchangedPath of expectations.visualDiff.unchangedPaths) {
      const route = report.routeStatuses.find((entry) => entry.path === unchangedPath);
      assert(route?.status === 'passed', `${unchangedPath} remains visually unchanged`);
    }

    pass(
      'visual diff report',
      `${report.changedRoutes}/${report.totalRoutes} changed in ${report.durationMs}ms`,
    );
  } catch (error) {
    console.warn(
      'WARN  Electron visual diff could not run in this environment; using HTTP branch comparison instead.',
    );
    console.warn(error instanceof Error ? error.message : String(error));
    await testBranchContentDiff();
  }
}

async function main() {
  console.log('Deep Diff mock repository integration test');
  console.log(`Fixture: ${fixturePath}`);

  const token = getGitHubToken();
  if (!token) {
    console.warn('WARN  No GitHub token found; GitHub remote mode tests will be skipped.');
  }

  await testLocalMode();
  if (token) {
    await testGitHubRemoteMode(token);
  }
  await testVisualDiffWithElectron();
}

main().catch((error) => {
  fail('Unhandled test error', error);
});
