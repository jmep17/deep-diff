// Runtime smoke test for CONSOLE_PATCH_SCRIPT — runs UNDER Electron so the patch
// executes in a real Chromium DOM and we observe what the `console-message` event
// actually reports. Closes the seam no pure test can: "does wrapping console.* to
// JSON.stringify object args BEFORE the real call make Chromium report JSON
// instead of collapsing it to [object Object]?"
//
// Run: electron scripts/test-console-patch.cjs   (pnpm run test:console-patch)
// Requires nothing built (pure renderer-string behavior).
const { app, BrowserWindow } = require('electron');

// Mirror of CONSOLE_PATCH_SCRIPT in src/App.tsx. Kept in sync by hand; this test
// fails loudly if the patch contract regresses.
const CONSOLE_PATCH_SCRIPT = `(() => {
  if (window.__ddsConsolePatched) return;
  window.__ddsConsolePatched = true;
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    if (a === null || a === undefined || typeof a !== 'object') return String(a);
    try { return JSON.stringify(a, null, 2); } catch (_e) { return String(a); }
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[m];
    if (typeof orig !== 'function') continue;
    console[m] = (...args) => orig.apply(console, args.map(fmt));
  }
})();`;

const HTML = `data:text/html,${encodeURIComponent('<body></body>')}`;

let failures = 0;
function assert(cond, label, detail = '') {
  if (cond) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false, width: 400, height: 300 });

    // Collect what Chromium reports for each console call. Electron's arg shape
    // changed across versions — handle both the (event, level, message) signature
    // and the legacy positional one.
    const messages = [];
    win.webContents.on('console-message', (...args) => {
      const e = args[0];
      const msg = e && typeof e === 'object' && 'message' in e ? e.message : String(args[2] ?? '');
      messages.push(msg);
    });

    await win.loadURL(HTML);

    // Baseline: WITHOUT the patch, an object logs as [object Object].
    await win.webContents.executeJavaScript(`console.log({ a: 1, b: 'x' }); true`);
    await new Promise((r) => setTimeout(r, 100));
    assert(
      messages.some((m) => m.includes('[object Object]')),
      'baseline collapses object to [object Object]',
      messages[messages.length - 1],
    );

    // Apply the patch, then log an object + nested structure.
    await win.webContents.executeJavaScript(CONSOLE_PATCH_SCRIPT);
    messages.length = 0;
    await win.webContents.executeJavaScript(
      `console.log({ items: [], total: 0 }); console.warn('plain string'); true`,
    );
    await new Promise((r) => setTimeout(r, 100));

    const joined = messages.join('\n');
    assert(!joined.includes('[object Object]'), 'patched: no [object Object]', joined.slice(0, 80));
    assert(
      messages.some((m) => m.includes('"total": 0') && m.includes('"items"')),
      'patched: object is JSON-stringified',
      messages.find((m) => m.includes('total')),
    );
    assert(
      messages.some((m) => m === 'plain string'),
      'patched: plain strings pass through unchanged',
    );

    console.log(
      failures === 0 ? '\nAll console-patch runtime tests passed.' : `\n${failures} failed.`,
    );
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
