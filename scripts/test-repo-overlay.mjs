// Plumbing test for repo overlays: files placed in the overlay dir are copied over the
// throwaway worktree before the dev server spawns, and visibly change what it serves.
//
// Pure Node (no Electron). Calls launchSidecar from dist-electron/ directly, passing
// overlayDir explicitly (main.ts resolves it in the app; here we supply it). Uses the
// storefront-auth0 scenario repo on a feature branch to force a worktree.
//
// Run: node scripts/test-repo-overlay.mjs  (requires dist-electron/ built + setup:fixtures)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = path.join(ROOT, 'mock-workspace', 'storefront-auth0');
const BRANCH = 'feature/holiday-storefront-redesign';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label, detail = '') {
  if (cond) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function waitServer(port) {
  for (let i = 0; i < 80; i++) {
    try {
      await fetchText(`http://127.0.0.1:${port}/`);
      return true;
    } catch {
      await delay(200);
    }
  }
  return false;
}

const pkill = () => new Promise((r) => execFile('pkill', ['-f', 'server.mjs'], () => r()));
const pruneWorktrees = () =>
  new Promise((r) => execFile('git', ['-C', REPO, 'worktree', 'prune'], () => r()));

async function launchAndRead(sidecar, overlayDir) {
  const status = await sidecar.launchSidecar({ repoPath: REPO, branch: BRANCH, overlayDir });
  let text = '';
  try {
    if (await waitServer(status.port)) {
      text = await fetchText(`http://127.0.0.1:${status.port}/`);
    }
  } finally {
    sidecar.stopSidecar();
    await pkill();
    await delay(300);
    await pruneWorktrees();
  }
  return text;
}

const main = async () => {
  const sidecar = await import(path.join(ROOT, 'dist-electron', 'sidecar.js'));
  const overlay = await import(path.join(ROOT, 'dist-electron', 'repoOverlay.js'));

  // Smoke the scaffold + README generator (runs in the launch path in the real app).
  const scaffoldRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-root-'));
  const scaffolded = await overlay.ensureOverlayScaffold(scaffoldRoot, REPO);
  const readme = await fs.readFile(path.join(scaffolded, overlay.OVERLAY_README_NAME), 'utf8');
  assert(
    scaffolded.startsWith(scaffoldRoot),
    'scaffold dir is under the overlays root',
    scaffolded,
  );
  assert(readme.includes(scaffolded), 'README states the exact resolved overlay path');
  const skip = await overlay.applyOverlay(
    await fs.mkdtemp(path.join(os.tmpdir(), 'wt-')),
    scaffolded,
  );
  assert(skip.length === 0, 'overlay with only the README applies nothing', JSON.stringify(skip));
  await fs.rm(scaffoldRoot, { recursive: true, force: true });

  // Baseline: no overlay → the real scenario page.
  const baseline = await launchAndRead(sidecar, undefined);
  assert(
    baseline.length > 0 && !baseline.includes('OVERLAY_MARKER'),
    'baseline serves real page',
    `${baseline.length} bytes`,
  );

  // Overlay a server.mjs that serves a unique marker → proves the file reached the worktree.
  const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-test-'));
  const MARKER = `OVERLAY_MARKER_${Date.now()}`;
  await fs.writeFile(
    path.join(overlayDir, 'server.mjs'),
    `import http from 'node:http';
const port = process.env.PORT || 3000;
http.createServer((_req, res) => res.end(${JSON.stringify(MARKER)})).listen(port, '127.0.0.1');
`,
  );
  // A reserved README in the overlay must NOT be copied into the worktree.
  await fs.writeFile(path.join(overlayDir, 'OVERLAY-README.md'), 'docs only');

  const overlaid = await launchAndRead(sidecar, overlayDir);
  assert(
    overlaid.includes(MARKER),
    'overlay server.mjs is served from the worktree',
    JSON.stringify(overlaid.slice(0, 40)),
  );

  await fs.rm(overlayDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll repo-overlay tests passed.' : `\n${failures} failed.`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
