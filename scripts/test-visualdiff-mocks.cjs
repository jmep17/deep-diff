// Probe: does the visual-diff path actually apply endpoint mocks?
// Runs runVisualDiff on storefront-auth0 (main vs main = zero code diff) for the
// /cart route, once WITHOUT overrides and once WITH an empty-cart override, then:
//   1. asserts the WITH-override run logged [network] ... (mock) lines, and
//   2. asserts the captured /cart image CHANGED vs the no-override run
//      (proves the mock reached the rendered page, not just the interceptor).
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.on('window-all-closed', (e) => e.preventDefault());

const repoPath = path.resolve(__dirname, '..', 'mock-workspace', 'storefront-auth0');
let failures = 0;
const ok = (c, m, d = '') => {
  if (c) console.log(`PASS ${m}${d ? ` — ${d}` : ''}`);
  else {
    console.error(`FAIL ${m}${d ? ` — ${d}` : ''}`);
    failures++;
  }
};

app
  .whenReady()
  .then(async () => {
    const { runVisualDiff } = await import('../dist-electron/visualDiff.js');

    const base = {
      repoPath,
      baseRef: 'main',
      targetRef: 'main',
      routes: ['/cart'],
      viewport: { width: 1024, height: 768 },
      mismatchTolerance: 0,
    };

    const plain = await runVisualDiff({ ...base });
    const mocked = await runVisualDiff({
      ...base,
      endpointOverrides: { 'GET:/api/cart': { items: [], subtotal: 0, tax: 0, total: 0 } },
    });

    const log = fs.readFileSync(mocked.logFile, 'utf8');
    ok(/\[network\].*\/api\/cart → 200 \(mock\)/.test(log), 'visual-diff logs a mock network hit');

    const plainRoute = plain.routes.find((r) => r.urlPath.includes('/cart'));
    const mockedRoute = mocked.routes.find((r) => r.urlPath.includes('/cart'));
    ok(plainRoute && mockedRoute, 'both runs captured /cart');

    // beforeImage is a data URL of the base capture. If the mock reached the page,
    // the mocked run's capture differs from the plain run's capture.
    ok(
      plainRoute && mockedRoute && plainRoute.beforeImage !== mockedRoute.beforeImage,
      'mocked /cart capture differs from un-mocked (mock reached the page)',
      `plainLen=${plainRoute?.beforeImage?.length} mockedLen=${mockedRoute?.beforeImage?.length}`,
    );

    console.log(failures === 0 ? '\nVISUAL-DIFF MOCK PROBE PASSED' : `\n${failures} FAILED`);
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
