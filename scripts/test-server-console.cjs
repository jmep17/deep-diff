// Real-Chromium test for the DIFF page-console capture seam.
//
// The visual diff loads each page in a hidden main-process BrowserWindow, so its
// browser console is captured directly via attachConsoleCapture (serverLogs.ts).
// This exercises that seam end-to-end — the pure-Node test-server-logs.mjs can't,
// since there's no Chromium there. (The sidecar's page console takes a different
// path: renderer <webview> -> logs:append IPC, covered by the app / agent-browser.)
//
// Run: electron scripts/test-server-console.cjs   (pnpm run test:server-console)
// Requires dist-electron/ built (pnpm run build:electron).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const logDir = path.join(os.tmpdir(), `deep-diff-logs-console-${Date.now()}`);
process.env.DEEP_DISH_LOG_DIR = logDir;

// Destroying our window before the diff section would otherwise close the last
// window and trigger Electron's default auto-quit. A no-op listener suppresses it
// so we control the exit explicitly via app.exit().
app.on('window-all-closed', () => {});

const repoPath = path.resolve(__dirname, '..', 'mock-workspace', 'storefront-auth0');

let failures = 0;
function assert(cond, label, detail = '') {
  if (cond) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

// runVisualDiff cleans worktrees fire-and-forget; a short-lived runner must prune
// leftovers itself (CLAUDE.md). The grandchild dev server is `node server.mjs …`.
function cleanupLeaks() {
  try {
    execSync("pkill -f 'server.mjs --'", { stdio: 'ignore' });
  } catch {
    // none running
  }
  try {
    execSync(`git -C "${repoPath}" worktree prune`, { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

const HTML = `data:text/html,${encodeURIComponent(`
  <body style="margin:0">
    <script>
      console.log('[dds-log-probe] hello from page');
      console.error('[dds-log-probe] boom');
    </script>
  </body>
`)}`;

app
  .whenReady()
  .then(async () => {
    const { LogSink, attachConsoleCapture } = await import(
      path.resolve(__dirname, '..', 'dist-electron', 'serverLogs.js')
    );
    const sink = new LogSink('console-test', 'diff', `diff-${Date.now()}.log`);
    const win = new BrowserWindow({ show: false, width: 640, height: 480 });

    // Mirror the diff: a single capture window, attributed to whichever server is
    // currently loading. attachConsoleCapture reads the getter at message time.
    const server = 'base';
    attachConsoleCapture(win.webContents, () => server, sink);

    await win.loadURL(HTML);
    await new Promise((r) => setTimeout(r, 400)); // console-message fires just after load

    const consoleEntries = sink.entries.filter((e) => e.stream === 'console');
    assert(
      consoleEntries.length >= 2,
      'page console messages captured',
      `n=${consoleEntries.length}`,
    );
    assert(
      consoleEntries.every((e) => e.server === 'base'),
      'captured console attributed to the active server (base)',
    );
    assert(
      consoleEntries.some((e) => e.text.includes('[dds-log-probe] hello from page')),
      'console.log message text captured',
    );
    assert(
      consoleEntries.some((e) => e.text.includes('boom') && e.level === 'error'),
      'console.error captured with error level',
    );

    sink.close();
    const fileText = fs.readFileSync(sink.file, 'utf8');
    assert(
      /\[base\] \[console/.test(fileText),
      'console line written to the file as [base] [console…]',
    );

    win.destroy();

    // --- Visual-diff log file: base vs target labeling (needs Electron) ------
    // visualDiff.js imports `electron`, so this can only run under the Electron
    // runtime — which is exactly why it lives here and not in test-server-logs.mjs.
    try {
      const { runVisualDiff } = await import(
        path.resolve(__dirname, '..', 'dist-electron', 'visualDiff.js')
      );
      const report = await runVisualDiff({
        repoPath,
        baseRef: 'main',
        targetRef: 'feature/holiday-storefront-redesign',
        routes: ['/cart'], // one control route — both servers still boot + log
      });
      assert(Boolean(report.logFile), 'runVisualDiff returns report.logFile', report.logFile);
      assert(
        Array.isArray(report.logs) && report.logs.length > 0,
        'report carries a logs snapshot',
        `len=${report.logs && report.logs.length}`,
      );
      const diffText = fs.readFileSync(report.logFile, 'utf8');
      assert(/\[base\] \[stdout\]/.test(diffText), 'diff log captures base server stdout');
      assert(/\[target\] \[stdout\]/.test(diffText), 'diff log captures target server stdout');
      assert(
        report.logs.some((e) => e.server === 'base') &&
          report.logs.some((e) => e.server === 'target'),
        'snapshot entries labeled base + target',
      );

      // Failure path — the whole point of the feature ("debug why it's NOT
      // working"). A dev command that exits immediately makes the base server
      // never come up; runVisualDiff must throw with the log-file path in the
      // message, and that file must hold the captured output.
      let threw = null;
      try {
        await runVisualDiff({
          repoPath,
          baseRef: 'main',
          targetRef: 'feature/holiday-storefront-redesign',
          routes: ['/cart'],
          command: 'node -e "process.exit(7)"',
        });
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      assert(threw !== null, 'a dev server that never comes up makes runVisualDiff throw');
      const m = threw && threw.match(/full log: (\S+\.log)/);
      assert(Boolean(m), 'failure message points at the log file', threw && threw.slice(0, 140));
      if (m) {
        const failText = fs.readFileSync(m[1], 'utf8');
        assert(
          /\[base\] \[system\] launching:/.test(failText),
          'failure log captured the launch attempt + output',
        );
      }
    } finally {
      cleanupLeaks();
    }

    console.log(
      failures === 0 ? '\nAll page-console + diff log tests passed.' : `\n${failures} failed.`,
    );
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    cleanupLeaks();
    app.exit(1);
  });
