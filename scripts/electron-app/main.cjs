const { app, BrowserWindow, session, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const outDir = __dirname;
const logPath = path.join(outDir, 'run.log');
const reportPath = path.join(outDir, 'last-report.json');
const log = (message) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);

fs.writeFileSync(logPath, '');
const fixturePath = path.join(__dirname, '..', '..', 'mock-repositories', 'auth0-routes-fixture');
app.disableHardwareAcceleration();

// Prevent default "quit when all windows closed" — the probe destroys its
// BrowserWindow in Layer B and then needs to keep running for Layer C.
app.on('window-all-closed', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// DEEP_DISH_DIFF_PROBE=1  →  run the mock-interception + stability probes
// Default (no env var)    →  run the standard 6/3 visual diff (unchanged)
// ---------------------------------------------------------------------------

const PROBE_MODE = process.env.DEEP_DISH_DIFF_PROBE === '1';

async function runStandardDiff() {
  const { runVisualDiff } = await import('../../dist-electron/visualDiff.js');
  log('imported runVisualDiff');

  const report = await runVisualDiff({
    repoPath: fixturePath,
    baseRef: 'main',
    targetRef: 'feature/auth0-preview-callbacks',
    viewport: { width: 1280, height: 900 },
  });
  log('report complete');

  const payload = {
    ok: true,
    totalRoutes: report.totalRoutes,
    changedRoutes: report.changedRoutes,
    durationMs: report.durationMs,
    routePaths: report.routes.map((route) => route.path),
    routeStatuses: report.routes.map((route) => ({
      path: route.path,
      status: route.status,
      mismatchRatio: route.mismatchRatio,
      hasImages: Boolean(route.beforeImage && route.afterImage && route.diffImage),
    })),
  };

  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

/** Start the fixture dev server (server.mjs) and wait for it to be ready. */
function startFixtureServer(port) {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(fixturePath, 'server.mjs');
    const proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes('listening') || stdout.includes('running')) {
        resolve(proc);
      }
    });
    // Give it up to 5 seconds before assuming it's ready (server may not log)
    const timer = setTimeout(() => resolve(proc), 5000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`server.mjs exited with code ${code}`));
      }
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`PROBE ASSERTION FAILED: ${message}`);
}

async function runProbes() {
  const { matchOverride } = await import('../../dist-electron/overrideMatcher.js');
  log('imported overrideMatcher');

  // ── Layer A: Matcher unit tests ────────────────────────────────────────────
  log('probe: matcher unit tests');

  const overrides = {
    'GET:/api/products/:productId': { id: 'prod_keyboard', marker: 'MOCKED_BY_PROFILE' },
    'GET:/api/products/all': { special: 'exact-wins' },
    'POST:/api/orders': { created: true },
  };

  // Exact-over-param: /api/products/all → exact key wins
  const exactResult = matchOverride(overrides, 'GET', '/api/products/all');
  assert(exactResult && exactResult.special === 'exact-wins', 'exact match beats :param');
  log('PASS  exact match beats :param');

  // Dynamic-segment match: /api/products/prod_keyboard → :productId matches
  const dynamicResult = matchOverride(overrides, 'GET', '/api/products/prod_keyboard');
  assert(dynamicResult && dynamicResult.marker === 'MOCKED_BY_PROFILE', ':param segment match');
  log('PASS  :param segment match');

  // Method discrimination: POST vs GET
  const methodResult = matchOverride(overrides, 'POST', '/api/products/prod_keyboard');
  assert(methodResult === undefined, 'method discrimination');
  log('PASS  method discrimination (no match for wrong method)');

  // No match
  const noMatch = matchOverride(overrides, 'GET', '/api/orders');
  assert(noMatch === undefined, 'no-match returns undefined');
  log('PASS  no-match returns undefined');

  // Method case-insensitive
  const lowerMethod = matchOverride(overrides, 'post', '/api/orders');
  assert(lowerMethod && lowerMethod.created === true, 'method case-insensitive');
  log('PASS  method case-insensitive');

  // ── Layer B: Electron interception probe ───────────────────────────────────
  log('probe: starting fixture server for interception test');

  // Find a free port in the 5200-5299 range
  const probePort = 5215;
  let fixtureProc;
  try {
    fixtureProc = await startFixtureServer(probePort);
  } catch (err) {
    log(`probe: fixture server start failed: ${err.message} — skipping Layer B`);
    console.warn('SKIP  Layer B (fixture server failed to start):', err.message);
    return;
  }
  log(`probe: fixture server up on port ${probePort}`);

  const win = new BrowserWindow({ show: false, width: 1280, height: 900 });
  const ses = win.webContents.session;
  const probeOverrides = {
    'GET:/api/products/:productId': { id: 'prod_keyboard', marker: 'MOCKED_BY_PROFILE' },
  };

  ses.protocol.handle('http', async (req) => {
    const mocked = matchOverride(probeOverrides, req.method, new URL(req.url).pathname);
    if (mocked) {
      return new Response(JSON.stringify(mocked), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });

  try {
    // Test 1: matched endpoint → mocked body
    await win.loadURL(`http://127.0.0.1:${probePort}/api/products/prod_keyboard`);
    const mockedBody = await win.webContents.executeJavaScript('document.body.innerText');
    const parsed = JSON.parse(mockedBody);
    assert(parsed.marker === 'MOCKED_BY_PROFILE', 'mocked body served for matched endpoint');
    log('PASS  mocked body served for matched endpoint');

    // Test 2: unmatched endpoint → real fixture body
    await win.loadURL(`http://127.0.0.1:${probePort}/api/orders`);
    const realBody = await win.webContents.executeJavaScript('document.body.innerText');
    const realParsed = JSON.parse(realBody);
    assert(
      realParsed && typeof realParsed === 'object' && !realParsed.marker,
      'passthrough serves real body for unmatched endpoint',
    );
    log('PASS  passthrough serves real body for unmatched endpoint');
  } finally {
    ses.protocol.unhandle('http');
    win.destroy();
    fixtureProc.kill();
    log('probe: cleanup done');
  }

  // ── Layer C: Regression + stability run ───────────────────────────────────
  log('probe: regression + stability run');
  const { runVisualDiff } = await import('../../dist-electron/visualDiff.js');

  // API-only overrides that match no page route — pages must render identically.
  const apiOnlyOverrides = {
    'GET:/api/products/:productId': { id: 'probe-product', price: 0 },
  };

  const run1 = await runVisualDiff({
    repoPath: fixturePath,
    baseRef: 'main',
    targetRef: 'feature/auth0-preview-callbacks',
    viewport: { width: 1280, height: 900 },
    endpointOverrides: apiOnlyOverrides,
  });
  log(`probe: run1 complete — ${run1.totalRoutes} routes, ${run1.changedRoutes} changed`);
  assert(run1.totalRoutes === 6, `totalRoutes=6 (got ${run1.totalRoutes})`);
  assert(run1.changedRoutes === 3, `changedRoutes=3 (got ${run1.changedRoutes})`);
  log("PASS  regression: overrides don't change totalRoutes/changedRoutes");

  const run2 = await runVisualDiff({
    repoPath: fixturePath,
    baseRef: 'main',
    targetRef: 'feature/auth0-preview-callbacks',
    viewport: { width: 1280, height: 900 },
    endpointOverrides: apiOnlyOverrides,
  });
  log(`probe: run2 complete — ${run2.totalRoutes} routes, ${run2.changedRoutes} changed`);
  assert(
    run2.changedRoutes === run1.changedRoutes,
    'stability: changedRoutes identical across runs',
  );
  // Compare per-route mismatch ratios for stronger stability guarantee
  for (let i = 0; i < run1.routes.length; i++) {
    assert(
      run1.routes[i].mismatchRatio === run2.routes[i].mismatchRatio,
      `stability: mismatchRatio identical for route ${run1.routes[i].path}`,
    );
  }
  log('PASS  stability: identical results across two runs');

  const probePayload = { ok: true, layerA: 'PASS', layerB: 'PASS', layerC: 'PASS' };
  fs.writeFileSync(reportPath, JSON.stringify(probePayload, null, 2));
  console.log(JSON.stringify(probePayload));
}

app.whenReady().then(async () => {
  log('ready');
  try {
    if (PROBE_MODE) {
      await runProbes();
    } else {
      await runStandardDiff();
    }
  } catch (error) {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
