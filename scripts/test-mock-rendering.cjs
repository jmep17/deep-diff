// End-to-end check of the new behavior: an active endpoint mock visibly changes
// the rendered page. Launches the storefront sidecar WITH endpoint overrides
// (so it is fronted by the mock proxy), loads each page in a real BrowserWindow
// (executing the client reconciler), and asserts the DOM reflects the mock —
// and that with NO override the page shows the real server-rendered baseline.
//
// Run: electron scripts/test-mock-rendering.cjs   (pnpm run test:mock-rendering)
// Requires dist-electron/ built first (pnpm run build:electron).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', 'mock-workspace', 'storefront-auth0');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label, detail = '') {
  if (cond) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}
const pkill = () => new Promise((r) => execFile('pkill', ['-f', 'server.mjs --'], () => r()));

function waitReady(url) {
  return new Promise((res) => {
    const req = http.get(url, (r) => {
      r.resume();
      res(true);
    });
    req.on('error', () => res(false));
    req.setTimeout(400, () => {
      req.destroy();
      res(false);
    });
  });
}

// Render `route` against the sidecar launched with `overrides`, return body text.
async function renderWith(sidecar, win, overrides, route) {
  const status = await sidecar.launchSidecar({
    repoPath: REPO,
    branch: 'main',
    endpointOverrides: overrides,
  });
  // Wait on the REAL server port (status.port), not status.url — with overrides
  // status.url is the proxy, which accepts connections before the server it
  // fronts is listening (it would answer with "Proxy error: ECONNREFUSED").
  for (let i = 0; i < 60; i++) {
    if (await waitReady(`http://127.0.0.1:${status.port}`)) break;
    await delay(200);
  }
  await win.loadURL(status.url + route);
  // Let the client reconciler fetch + re-render.
  await delay(700);
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  sidecar.stopSidecar();
  await pkill();
  await delay(250);
  return text;
}

app
  .whenReady()
  .then(async () => {
    const sidecar = await import(path.resolve(__dirname, '..', 'dist-electron', 'sidecar.js'));
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    // 1. No override → real baseline.
    const cartReal = await renderWith(sidecar, win, undefined, '/cart');
    assert(
      /Subtotal:\s*\$368/.test(cartReal),
      'cart shows real subtotal with no override',
      JSON.stringify(cartReal.slice(0, 60)),
    );

    // 2. Empty-cart mock → empty state.
    const cartEmpty = await renderWith(
      sidecar,
      win,
      { 'GET:/api/cart': { items: [], subtotal: 0, currency: 'USD' } },
      '/cart',
    );
    assert(
      /cart is empty/i.test(cartEmpty),
      'empty-cart mock renders the empty state',
      JSON.stringify(cartEmpty.slice(0, 80)),
    );

    // 3. Free-plan mock on /api/auth/me → upgrade prompt.
    const accountFree = await renderWith(
      sidecar,
      win,
      {
        'GET:/api/auth/me': {
          name: 'Jordan Fixture',
          email: 'jordan@storefront.local',
          plan: 'Free',
          memberSince: '2024-03-01',
        },
      },
      '/account',
    );
    assert(
      /Free plan/i.test(accountFree) && /Upgrade to Pro/i.test(accountFree),
      'Free-plan mock renders the upgrade prompt',
      JSON.stringify(accountFree.slice(0, 120)),
    );

    // 4. Fewer-products mock → count reflects the mock.
    const productsOne = await renderWith(
      sidecar,
      win,
      {
        'GET:/api/products': {
          items: [{ id: 'solo', name: 'Solo Item', price: 9, blurb: 'Only one.' }],
          total: 1,
        },
      },
      '/products',
    );
    assert(
      /1 product in the catalog/.test(productsOne),
      'single-product mock updates the count',
      JSON.stringify(productsOne.slice(0, 80)),
    );

    console.log(failures === 0 ? '\nAll mock-rendering tests passed.' : `\n${failures} failed.`);
    win.destroy();
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
