#!/usr/bin/env node
// Tests the single-server sidecar path WITH mock overrides active.
//
// launchSidecar() spawns ONE dev server and ALWAYS fronts it with a pass-through
// proxy (electron/sidecar.ts -> startProxyServer): matched METHOD:path keys return
// the mock body; everything else passes through to the real server, while the JSON
// endpoints the app actually hits are recorded for runtime discovery. This is pure
// Node (no Electron), so it runs as a plain script, the same way
// scripts/test-mock-repository.mjs exercises the sidecar.
//
// Requires dist-electron/ to be built first (pnpm run build:electron).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchSidecar,
  stopSidecar,
  getSidecarStatus,
  getObservedEndpoints,
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

// Wait until a PASSTHROUGH route returns 200. Polling the proxy root isn't
// enough: the proxy is up immediately but the real dev server behind it may not
// be, and an early passthrough returns the proxy's 502. /api/health is never
// overridden here, so a 200 from it means the underlying server is ready.
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

const MARKER = 'MOCKED_BY_PROFILE';

async function main() {
  console.log('Deep Diff — sidecar + active mocks test');
  console.log(`Repo: ${repoPath}`);

  // ── Case 1: sidecar WITH overrides → proxy fronts the dev server ───────────
  const overrides = {
    'GET:/api/products': {
      items: [{ id: 'prod_mock', name: 'Mocked Keyboard', price: 1 }],
      total: 1,
      marker: MARKER,
    },
    'GET:/api/products/:productId': { id: 'prod_mock', name: 'Mocked Detail', marker: MARKER },
  };

  const sidecar = await launchSidecar({ repoPath, branch: 'main', endpointOverrides: overrides });
  try {
    assert(sidecar.running, 'sidecar launches');
    assert(Boolean(sidecar.url), 'sidecar exposes a URL (proxy)', sidecar.url);
    // The exposed URL must be the proxy port, not the raw dev-server port.
    assert(
      sidecar.url !== `http://127.0.0.1:${sidecar.port}`,
      'exposed URL is the mock proxy, not the raw server',
      `proxy=${sidecar.url} server=:${sidecar.port}`,
    );
    await waitForReady(sidecar.url);

    // 1a. Overridden exact route → mock body
    const exact = await (await fetch(new URL('/api/products', sidecar.url))).json();
    assert(
      exact.marker === MARKER && exact.total === 1,
      'exact override served from mock profile',
      `total=${exact.total}`,
    );

    // 1b. Overridden :param route → mock body via dynamic segment match
    const param = await (await fetch(new URL('/api/products/prod_keyboard', sidecar.url))).json();
    assert(param.marker === MARKER, ':param override served from mock profile');

    // 1c. Non-overridden API → real passthrough body
    const health = await (await fetch(new URL('/api/health', sidecar.url))).json();
    assert(
      health.service === 'storefront-auth0' && !health.marker,
      'non-overridden API passes through to real server',
    );

    // 1d. Method discrimination: POST /api/products is NOT in overrides (GET only) → passthrough
    const created = await (
      await fetch(new URL('/api/products', sidecar.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Real Product' }),
      })
    ).json();
    assert(
      created.id === 'prod_created' && !created.marker,
      'POST passes through (method-specific override not matched)',
    );

    // 1e. Page route → real HTML passthrough (proxy only mocks matched JSON)
    const homeRes = await fetch(new URL('/', sidecar.url));
    const homeHtml = await homeRes.text();
    assert(
      homeRes.headers.get('content-type')?.includes('text/html'),
      'page route passes through as HTML',
    );
    assert(homeHtml.includes('Outfit your desk'), 'page HTML is the real (baseline) render');

    // 1f. Runtime discovery: JSON responses (mock-served or passthrough) are
    // recorded as mockable endpoints; the HTML page route is not.
    const observed = getObservedEndpoints().map(
      (endpoint) => `${endpoint.method}:${endpoint.path}`,
    );
    assert(
      observed.includes('GET:/api/products'),
      'runtime discovery records observed JSON endpoints',
      observed.join(', '),
    );
    assert(!observed.includes('GET:/'), 'HTML page route is not recorded as an endpoint');

    assert(getSidecarStatus().running, 'sidecar status reports running');
  } finally {
    stopSidecar();
    assert(!getSidecarStatus().running, 'sidecar stops cleanly');
  }

  // ── Case 2: sidecar WITHOUT overrides → always-on proxy, pure passthrough ──
  const plain = await launchSidecar({ repoPath, branch: 'main' });
  try {
    assert(plain.running, 'sidecar launches without overrides');
    assert(
      plain.url !== `http://127.0.0.1:${plain.port}`,
      'no-override URL is the always-on pass-through proxy, not the raw server',
      `proxy=${plain.url} server=:${plain.port}`,
    );
    await waitForReady(plain.url);
    const products = await (await fetch(new URL('/api/products', plain.url))).json();
    assert(
      products.total === 3 && !products.marker,
      'without overrides, the proxy passes through the real API body',
      `total=${products.total}`,
    );
  } finally {
    stopSidecar();
  }

  console.log(
    failures === 0 ? '\nALL SIDECAR MOCK TESTS PASSED' : `\n${failures} ASSERTION(S) FAILED`,
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
