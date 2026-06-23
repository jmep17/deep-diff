/**
 * End-to-end test for the network-capture pipeline (run under Electron:
 * `electron scripts/test-capture-interceptor.cjs`; wired as `pnpm run
 * test:capture-interceptor`). Precedent: scripts/test-change-probe.cjs.
 *
 * Drives the REAL host modules (dist-electron/captureSink.js + mockCapture.js),
 * so it proves the whole chain the feature rests on:
 *   1. Injection/timing — the capture preload installs the interceptor in the
 *      page MAIN world early enough to catch a fetch fired by the page's first
 *      inline <script> (before DOMContentLoaded), an XHR, and a fetch after a
 *      full navigation (preload re-runs).
 *   2. Report-back fidelity — each body reaches the host losslessly via the
 *      privileged `dds-capture://` scheme (a same-origin POST body is unreadable
 *      via webRequest), incl. an XHR `responseType:'json'` body (the axios case)
 *      and a top-level ARRAY body.
 *   3. mockCapture/sanitize — bodies land in `getCaptures()` keyed METHOD:path
 *      with PII redacted.
 *
 * Requires `pnpm run build:electron` first (inject bundle + dist-electron).
 */
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, session, protocol } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'dist-electron', 'capture-preload.cjs');
const distUrl = (f) => pathToFileURL(path.join(__dirname, '..', 'dist-electron', f)).href;

// The capture scheme must be registered as privileged before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dds-capture',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

function page(bodyScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><script>
${bodyScript}
</script></head><body><h1>capture harness</h1></body></html>`;
}

const PAGES = {
  '/': page(`
    fetch('/api/fetch-early').then(function (r) { return r.json(); });
    var x = new XMLHttpRequest();
    x.open('GET', '/api/xhr'); x.responseType = 'json'; x.send();
    fetch('/api/user');
    fetch('/api/list');
  `),
  '/page2': page(`fetch('/api/after-nav');`),
};

const JSON_ROUTES = {
  '/api/fetch-early': { ok: true, source: 'fetch-early', items: [1, 2, 3] },
  '/api/xhr': { ok: true, source: 'xhr' },
  '/api/after-nav': { ok: true, source: 'after-nav' },
  '/api/user': { name: 'Jordan', email: 'jordan@example.com' },
  '/api/list': [{ id: 1 }, { id: 2 }],
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      if (PAGES[p]) {
        // Strict CSP with NO 'unsafe-inline' — proves the interceptor still
        // installs on targets that forbid inline page scripts (a large class of
        // real React/Vite/Next apps).
        return void res
          .writeHead(200, {
            'content-type': 'text/html',
            'content-security-policy': "default-src 'self'; script-src 'self'",
          })
          .end(PAGES[p]);
      }
      if (p in JSON_ROUTES) {
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(JSON_ROUTES[p]));
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { attachCaptureSink } = await import(distUrl('captureSink.js'));
  const { getCaptures, clearCaptures, captureCount } = await import(distUrl('mockCapture.js'));

  const failures = [];
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;

  const ses = session.fromPartition('capture-interceptor-test');
  clearCaptures();
  attachCaptureSink(ses);

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      session: ses,
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadURL(`${origin}/`);
  await wait(1200);
  await win.loadURL(`${origin}/page2`);
  await wait(1200);

  const caps = getCaptures();
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  // 1. fetch fired by the first inline script (pre-DOMContentLoaded).
  expect(caps['GET:/api/fetch-early'], 'missing GET:/api/fetch-early (early inline fetch)');
  if (caps['GET:/api/fetch-early']) {
    expect(
      JSON.stringify(caps['GET:/api/fetch-early'].items) === '[1,2,3]',
      'fetch-early items array corrupted',
    );
  }
  // 2. XHR with responseType:'json' (the axios case the lib mangled).
  expect(
    caps['GET:/api/xhr'] && caps['GET:/api/xhr'].source === 'xhr',
    'missing/!json XHR capture',
  );
  // 3. fetch after a full navigation (preload re-installs).
  expect(caps['GET:/api/after-nav'], 'missing GET:/api/after-nav (post-navigation)');
  // 4. PII redaction in the captured body.
  expect(caps['GET:/api/user'], 'missing GET:/api/user');
  if (caps['GET:/api/user']) {
    expect(caps['GET:/api/user'].email === '[REDACTED]', 'email not redacted by sanitize');
    expect(caps['GET:/api/user'].name === 'Jordan', 'non-sensitive field lost');
  }
  // 5. Top-level array body captured intact.
  expect(Array.isArray(caps['GET:/api/list']), 'array body not captured as an array');
  if (Array.isArray(caps['GET:/api/list'])) {
    expect(caps['GET:/api/list'].length === 2, 'array body length wrong');
  }
  expect(captureCount() === 5, `captureCount ${captureCount()} expected 5`);

  win.destroy();
  server.close();

  console.log(`captureCount: ${captureCount()}`);
  for (const k of Object.keys(caps)) console.log(`  ${k}`);

  if (failures.length) {
    console.error('\nFAIL:');
    for (const f of failures) console.error('  - ' + f);
    return 1;
  }
  console.log(
    '\nPASS: fetch/XHR(json)/array/post-nav captured via dds-capture scheme; PII redacted',
  );
  return 0;
}

app.on('window-all-closed', () => {});

app
  .whenReady()
  .then(run)
  .then((code) => app.exit(code))
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
