#!/usr/bin/env node
// Tests LIVE mock-override updates on an ALREADY-RUNNING sidecar (no relaunch).
//
// setSidecarOverrides() (electron/sidecar.ts) swaps the always-on proxy's mutable
// override map in place; the proxy fronts the dev server from launch, so the new
// map is served on the next request with no relaunch and no URL change. This is the
// engine behind the renderer's floating-toolbar toggles. Pure Node (no Electron),
// so it runs as a plain script like scripts/test-sidecar-mocks.mjs.
//
// Maps to the ticket's acceptance criteria:
//   AC1 toggling a mock updates the live server without a manual relaunch
//   AC2 non-matched requests still pass through to the real dev server
//   AC3 turning a mock off restores the real response
//
// Requires dist-electron/ to be built first (pnpm run build:electron).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchSidecar,
  stopSidecar,
  getSidecarStatus,
  setSidecarOverrides,
} from '../dist-electron/sidecar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const repoPath = path.join(projectRoot, 'mock-workspace', 'storefront-auth0');

let failures = 0;
const pass = (label, detail = '') => console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
};
const assert = (cond, label, detail) => (cond ? pass(label, detail) : fail(label, detail));

// Wait until a PASSTHROUGH route returns 200. /api/health is never overridden
// here, so a 200 from it means the real dev server behind the (proxy or raw)
// URL is actually listening — see the rationale in test-sidecar-mocks.mjs.
async function waitForReady(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(new URL('/api/health', url));
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for real server behind ${url}`);
}

const getJson = async (base, route, init) => (await fetch(new URL(route, base), init)).json();

const MARKER = 'MOCKED_LIVE';
const rawServerUrl = (s) => `http://127.0.0.1:${s.port}`;

async function main() {
  console.log('Deep Diff — live mock-update (no relaunch) test');
  console.log(`Repo: ${repoPath}`);

  // ── Case 1: launched WITH overrides (proxy already up) ─────────────────────
  // Toggle live OFF then ON-with-a-different-mock; the running proxy must follow
  // each change with no relaunch, and pass non-matched routes through throughout.
  const start = await launchSidecar({
    repoPath,
    branch: 'main',
    endpointOverrides: { 'GET:/api/products': { total: 1, marker: MARKER } },
  });
  try {
    assert(start.running, 'case1: sidecar launches with overrides');
    assert(start.url !== rawServerUrl(start), 'case1: exposed URL is the proxy', start.url);
    await waitForReady(start.url);

    const initial = await getJson(start.url, '/api/products');
    assert(
      initial.marker === MARKER && initial.total === 1,
      'case1: initial mock served',
      `total=${initial.total}`,
    );

    // AC3 — turn the mock OFF live: empty map ⇒ everything passes through.
    const offStatus = await setSidecarOverrides({});
    assert(
      offStatus.url === start.url,
      'case1: turning mocks off keeps the proxy URL stable',
      offStatus.url,
    );
    const real = await getJson(start.url, '/api/products');
    assert(
      real.total === 3 && !real.marker,
      'case1 (AC3): mock off restores the real response',
      `total=${real.total}`,
    );
    const healthOff = await getJson(start.url, '/api/health');
    assert(
      healthOff.service === 'storefront-auth0' && !healthOff.marker,
      'case1 (AC2): non-matched route passes through',
      'after off',
    );

    // AC1 — turn a DIFFERENT mock ON live, no relaunch.
    await setSidecarOverrides({ 'GET:/api/products': { total: 99, marker: MARKER } });
    const remock = await getJson(start.url, '/api/products');
    assert(
      remock.marker === MARKER && remock.total === 99,
      'case1 (AC1): new mock applied live without relaunch',
      `total=${remock.total}`,
    );
    const healthOn = await getJson(start.url, '/api/health');
    assert(
      healthOn.service === 'storefront-auth0' && !healthOn.marker,
      'case1 (AC2): non-matched route still passes through',
      'after on',
    );
  } finally {
    stopSidecar();
    assert(!getSidecarStatus().running, 'case1: sidecar stops cleanly');
  }

  // ── Case 2: launched WITHOUT overrides → always-on proxy, no repoint ───────
  // The proxy fronts the server from launch even with zero overrides, so applying
  // the first override neither relaunches nor changes status.url — it just starts
  // being served at the same proxy URL.
  const plain = await launchSidecar({ repoPath, branch: 'main' });
  try {
    assert(plain.running, 'case2: sidecar launches without overrides');
    assert(
      plain.url !== rawServerUrl(plain),
      'case2: no-override URL is the always-on proxy, not the raw server',
      `proxy=${plain.url} server=${rawServerUrl(plain)}`,
    );
    await waitForReady(plain.url);

    const beforeProducts = await getJson(plain.url, '/api/products');
    assert(
      beforeProducts.total === 3 && !beforeProducts.marker,
      'case2: with no overrides the proxy passes through the real response',
      `total=${beforeProducts.total}`,
    );

    // AC1 — apply the first override live; URL must NOT change (proxy already up).
    const proxied = await setSidecarOverrides({
      'GET:/api/products/:productId': { id: 'prod_mock', marker: MARKER },
    });
    assert(
      proxied.url === plain.url,
      'case2: first override is served at the same proxy URL (no repoint)',
      `was=${plain.url} now=${proxied.url}`,
    );

    // AC1 — the :param mock is served live, no relaunch.
    const detail = await getJson(plain.url, '/api/products/prod_keyboard');
    assert(detail.marker === MARKER, 'case2 (AC1): live :param mock served without relaunch');

    // AC2 — non-matched routes (different segment count, and /api/health) pass through.
    const listThrough = await getJson(plain.url, '/api/products');
    assert(
      listThrough.total === 3 && !listThrough.marker,
      'case2 (AC2): non-matched route passes through',
      `total=${listThrough.total}`,
    );
    const healthThrough = await getJson(plain.url, '/api/health');
    assert(
      healthThrough.service === 'storefront-auth0' && !healthThrough.marker,
      'case2 (AC2): /api/health passes through',
    );

    // AC3 — turn the live mock off; the previously-mocked route returns real data.
    await setSidecarOverrides({});
    const detailReal = await getJson(plain.url, '/api/products/prod_keyboard');
    assert(!detailReal.marker, 'case2 (AC3): turning the live mock off restores the real response');
  } finally {
    stopSidecar();
    assert(!getSidecarStatus().running, 'case2: sidecar stops cleanly');
  }

  // Best-effort: stopSidecar kills the pnpm/npm wrapper, but the grandchild
  // `node server.mjs` can linger and hold its port (see CLAUDE.md). Prune it so
  // repeated runs don't accumulate listeners.
  await new Promise((resolve) => execFile('pkill', ['-f', 'server.mjs --'], () => resolve()));

  console.log(
    failures === 0 ? '\nALL LIVE MOCK-UPDATE TESTS PASSED' : `\n${failures} ASSERTION(S) FAILED`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(
    'Unhandled error:',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
