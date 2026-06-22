// Runtime smoke test for the change-probe collector — runs UNDER Electron so the
// collector executes in a real Chromium DOM (getBoundingClientRect is real, and
// webContents.executeJavaScript serialization is exercised end-to-end).
//
// This closes the seam the pure unit test (scripts/test-change-link.mjs) cannot:
// "does the injected collector actually return probes from a live page, and do
// they flow through buildChangeLinks?"
//
// Run: electron scripts/test-change-probe.cjs   (pnpm run test:change-probe)
// Requires dist-electron/ built first (pnpm run build:electron).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// Mirror of CHANGE_PROBE_SCRIPT in src/App.tsx. Kept in sync by hand; this test
// fails loudly if the collector contract (attr/fiber -> {sourcePath,rect,tag})
// regresses. The data-dds-source path is React-version-independent.
const CHANGE_PROBE_SCRIPT = `(() => {
  const out = [];
  const attrSource = (el) =>
    el.getAttribute('data-dds-source') ||
    el.getAttribute('data-source') ||
    el.getAttribute('data-inspector-relative-path') || '';
  const fiberSource = (el) => {
    for (const key in el) {
      if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
        let fiber = el[key];
        let depth = 0;
        while (fiber && depth < 40) {
          const src = fiber._debugSource;
          if (src && src.fileName) {
            return src.fileName + (src.lineNumber ? ':' + src.lineNumber : '');
          }
          fiber = fiber._debugOwner || fiber.return;
          depth++;
        }
      }
    }
    return '';
  };
  const nodes = document.body ? document.body.querySelectorAll('*') : [];
  let id = 0;
  for (const el of nodes) {
    const source = attrSource(el) || fiberSource(el);
    if (!source) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({
      id: 'el' + id++,
      sourcePath: source,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      tag: el.tagName.toLowerCase(),
    });
    if (id > 4000) break;
  }
  return out;
})()`;

const HTML = `data:text/html,${encodeURIComponent(`
  <body style="margin:0">
    <div data-dds-source="server.mjs:12" style="width:120px;height:40px">changed</div>
    <section data-dds-source="app/page.tsx" style="width:80px;height:30px">unchanged</section>
    <span style="width:10px;height:10px">no source</span>
  </body>
`)}`;

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
    const win = new BrowserWindow({ show: false, width: 800, height: 600 });
    await win.loadURL(HTML);
    const probes = await win.webContents.executeJavaScript(CHANGE_PROBE_SCRIPT);

    assert(
      Array.isArray(probes),
      'collector returns an array',
      JSON.stringify(probes)?.slice(0, 80),
    );
    assert(
      probes.length === 2,
      'collector finds the 2 source-tagged elements',
      `len=${probes.length}`,
    );
    const bySource = Object.fromEntries(probes.map((p) => [p.sourcePath, p]));
    assert('server.mjs:12' in bySource, 'probe keeps raw source incl. line');
    assert(
      bySource['server.mjs:12'] && bySource['server.mjs:12'].rect.width > 0,
      'probe has a real non-zero rect',
    );

    const { buildChangeLinks } = await import(
      path.resolve(__dirname, '..', 'dist-electron', 'changeLink.js')
    );
    const repo = path.resolve(__dirname, '..', 'mock-workspace', 'storefront-auth0');
    const links = buildChangeLinks(repo, ['server.mjs'], probes);
    assert(
      links.length === 1,
      'buildChangeLinks keeps only the changed-file element',
      `len=${links.length}`,
    );
    assert(links[0] && links[0].file === 'server.mjs', 'matched link carries repo-relative file');
    assert(links[0] && links[0].rect.width > 0, 'matched link preserves the rect for overlay');

    console.log(
      failures === 0 ? '\nAll change-probe runtime tests passed.' : `\n${failures} failed.`,
    );
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
