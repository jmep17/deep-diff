#!/usr/bin/env node
// Integration test for the real-diff scenario repos under mock-workspace/.
//
// Verifies, for each scenario repo:
//   - scanWorkspace discovers it (multi-repo workspace path)
//   - Auth0 detection matches expectations (storefront: true, marketing: false)
//   - endpoint + visual-route scans match expectations
//   - a real headless visual diff flags exactly the changed routes and leaves
//     control routes byte-identical (mismatchRatio === 0)
//
// Requires dist-electron/ to be built first (pnpm run build:electron).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEndpoints } from '../dist-electron/endpointScanner.js';
import { scanVisualRoutes } from '../dist-electron/routeDetection.js';
import { detectAuth0Config } from '../dist-electron/authConfigDetector.js';
import { scanWorkspace, listLocalBranches } from '../dist-electron/repositories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.join(projectRoot, 'mock-workspace');
const electronCli = path.join(projectRoot, 'node_modules', '.bin', 'electron');
const runnerDir = path.join(projectRoot, 'scripts', 'visual-diff-electron');

const scenarios = ['storefront-auth0', 'marketing-site'];

let failures = 0;
function pass(label, detail = '') {
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail = '') {
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
}
function assert(condition, label, detail) {
  if (condition) pass(label, detail);
  else fail(label, detail);
}

// runVisualDiff cleans worktrees fire-and-forget (visualDiff.ts), so a runner
// that quits immediately after the diff can race it and leak worktrees. Prune
// deterministically so repeated test runs leave the repo clean.
function pruneWorktrees(repoPath) {
  try {
    const list = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    for (const line of list.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const wt = line.slice('worktree '.length).trim();
      if (wt.includes('deep-dish-diff') && wt.includes('worktrees')) {
        try {
          execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', wt], {
            stdio: 'ignore',
          });
        } catch {
          // already gone
        }
      }
    }
    execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
  } catch {
    // best-effort
  }
}

function runVisualDiffElectron(repoPath, baseRef, targetRef) {
  const outPath = path.join(
    os.tmpdir(),
    `deep-dish-scenario-${path.basename(repoPath)}-${Date.now()}.json`,
  );
  const env = {
    ...process.env,
    DEEP_DISH_REPO: repoPath,
    DEEP_DISH_BASE: baseRef,
    DEEP_DISH_TARGET: targetRef,
    DEEP_DISH_OUT: outPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(electronCli, [runnerDir], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.rmSync(outPath, { force: true });
  return report;
}

async function testWorkspaceDiscovery() {
  console.log('\n=== Multi-repo workspace discovery ===');
  const workspace = await scanWorkspace(workspaceRoot);
  const names = workspace.repositories.map((repo) => repo.name).sort();
  assert(
    scenarios.every((name) => names.includes(name)),
    'scanWorkspace discovers both scenario repos',
    names.join(', '),
  );
}

async function testScenario(name) {
  console.log(`\n=== Scenario: ${name} ===`);
  const repoPath = path.join(workspaceRoot, name);
  const expectations = JSON.parse(
    fs.readFileSync(path.join(repoPath, 'fixture-expectations.json'), 'utf8'),
  );

  // Auth0 detection
  const auth0 = await detectAuth0Config(repoPath);
  assert(
    auth0 === expectations.auth0.detected,
    `Auth0 detection is ${expectations.auth0.detected}`,
    `got ${auth0}`,
  );

  // Branches present
  const branches = await listLocalBranches(repoPath);
  assert(
    branches.includes(expectations.branches.base),
    `has base branch ${expectations.branches.base}`,
  );
  assert(
    branches.includes(expectations.branches.target),
    `has target branch ${expectations.branches.target}`,
  );

  // Endpoint scan
  const endpoints = await scanEndpoints(repoPath);
  assert(
    endpoints.length >= expectations.endpoints.minimumCount,
    `endpoint count >= ${expectations.endpoints.minimumCount}`,
    `${endpoints.length} found`,
  );
  for (const required of expectations.endpoints.requiredPaths) {
    assert(
      endpoints.some(
        (endpoint) => endpoint.path === required || endpoint.path.startsWith(required),
      ),
      `endpoint scan finds ${required}`,
    );
  }

  // Visual route scan
  const routes = await scanVisualRoutes(repoPath);
  assert(
    routes.length === expectations.visualDiff.totalRoutes,
    `detects ${expectations.visualDiff.totalRoutes} visual routes`,
    `${routes.length} found`,
  );

  // Headless visual diff
  const report = runVisualDiffElectron(
    repoPath,
    expectations.branches.base,
    expectations.branches.target,
  );
  pruneWorktrees(repoPath);
  assert(report.ok === true, 'visual diff run succeeded', report.error ?? '');
  if (!report.ok) return;

  assert(
    report.routeStatuses.every((route) => route.hasImages),
    'every route produced before/after/diff images',
  );

  const changed = report.routeStatuses
    .filter((route) => route.status === 'failed')
    .map((route) => route.path)
    .sort();
  const expectedChanged = [...expectations.visualDiff.changedPaths].sort();
  assert(
    JSON.stringify(changed) === JSON.stringify(expectedChanged),
    'changed routes match expectations',
    `changed: [${changed.join(', ')}]`,
  );

  for (const unchangedPath of expectations.visualDiff.unchangedPaths) {
    const route = report.routeStatuses.find((entry) => entry.path === unchangedPath);
    assert(
      route && route.status === 'passed' && route.mismatchRatio === 0,
      `${unchangedPath} is byte-identical (mismatchRatio 0)`,
      route ? `ratio ${route.mismatchRatio}` : 'route missing',
    );
  }

  pass(
    `${name} visual diff`,
    `${report.changedRoutes}/${report.totalRoutes} changed in ${report.durationMs}ms`,
  );
}

async function main() {
  console.log('Deep Dish Diff — real-diff scenario repo tests');
  console.log(`Workspace: ${workspaceRoot}`);
  await testWorkspaceDiscovery();
  for (const name of scenarios) {
    await testScenario(name);
  }
  console.log(failures === 0 ? '\nALL SCENARIO TESTS PASSED' : `\n${failures} ASSERTION(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(
    'Unhandled error:',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
