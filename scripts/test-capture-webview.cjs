/**
 * Capture test for the SIDECAR <webview> surface (run under Electron:
 * `electron scripts/test-capture-webview.cjs`; wired as `pnpm run
 * test:capture-webview`).
 *
 * The visual-diff path uses a BrowserWindow+preload (covered by
 * test-capture-interceptor.cjs). The sidecar preview is a <webview> tag whose
 * preload is FORCE-injected by the host via `will-attach-webview` (main.ts) —
 * different attach mechanics. This harness replicates that wiring and proves a
 * call fired inside the guest <webview> is captured into `getCaptures()` through
 * the real captureSink + mockCapture, under a strict CSP.
 *
 * Requires `pnpm run build:electron` first.
 */
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, session, protocol } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'dist-electron', 'capture-preload.cjs');
const distUrl = (f) => pathToFileURL(path.join(__dirname, '..', 'dist-electron', f)).href;
const PARTITION = 'capture-webview-test';

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

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const csp = { 'content-security-policy': "default-src 'self'; script-src 'self'" };
      if (p === '/host') {
        // Host page embeds the guest <webview> (partition matches the sink).
        return void res.writeHead(200, { 'content-type': 'text/html', ...csp }).end(
          `<!doctype html><html><body><webview src="${origin}/guest" partition="${PARTITION}"
             style="width:600px;height:400px"></webview></body></html>`,
        );
      }
      if (p === '/guest') {
        return void res.writeHead(200, { 'content-type': 'text/html', ...csp }).end(
          `<!doctype html><html><head><meta charset="utf-8"><script>
             fetch('/api/wv').then(function (r) { return r.json(); });
           </script></head><body><h1>guest</h1></body></html>`,
        );
      }
      if (p === '/api/wv') {
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, via: 'webview', items: [1, 2] }));
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { attachCaptureSink } = await import(distUrl('captureSink.js'));
  const { getCaptures, clearCaptures } = await import(distUrl('mockCapture.js'));

  const failures = [];
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;

  // Sink + CSP strip on the guest partition (as main.ts does for 'sidecar-preview').
  clearCaptures();
  attachCaptureSink(session.fromPartition(PARTITION));

  const host = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });

  // Force OUR capture preload onto the attached <webview> — mirrors main.ts.
  host.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  await host.loadURL(`${origin}/host`);
  await wait(2500); // let the <webview> attach, load, and fire its fetch

  const caps = getCaptures();
  if (!caps['GET:/api/wv'])
    failures.push('missing GET:/api/wv (guest <webview> fetch not captured)');
  else if (JSON.stringify(caps['GET:/api/wv'].items) !== '[1,2]')
    failures.push('guest body corrupted');

  host.destroy();
  server.close();

  console.log(`captured keys: [${Object.keys(caps).join(', ')}]`);
  if (failures.length) {
    console.error('\nFAIL:');
    for (const f of failures) console.error('  - ' + f);
    return 1;
  }
  console.log('\nPASS: guest <webview> fetch captured via force-injected preload under CSP');
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
