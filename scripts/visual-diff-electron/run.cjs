// Generic headless Electron runner for runVisualDiff.
//
// Unlike scripts/electron-app/main.cjs (hard-wired to auth0-routes-fixture),
// this runner is parametrized so it can drive a visual diff against ANY repo.
//
// Inputs (env):
//   DEEP_DISH_REPO   absolute path to the repo to diff (required)
//   DEEP_DISH_BASE   base ref (default "main")
//   DEEP_DISH_TARGET target ref (required)
//   DEEP_DISH_OUT    file path to write the JSON report to (optional)
//
// It writes the report JSON to DEEP_DISH_OUT (robust against stdout noise) and
// also prints a single JSON line to stdout.
const { app } = require('electron');
const fs = require('node:fs');

const repoPath = process.env.DEEP_DISH_REPO;
const baseRef = process.env.DEEP_DISH_BASE || 'main';
const targetRef = process.env.DEEP_DISH_TARGET;
const outPath = process.env.DEEP_DISH_OUT;

app.disableHardwareAcceleration();
// runVisualDiff destroys its capture window; keep the app alive until we quit.
app.on('window-all-closed', (event) => event.preventDefault());

function emit(payload) {
  const json = JSON.stringify(payload);
  if (outPath) {
    try {
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    } catch {
      // best-effort file write
    }
  }
  process.stdout.write(json + '\n');
}

app.whenReady().then(async () => {
  try {
    if (!repoPath) throw new Error('DEEP_DISH_REPO is required');
    if (!targetRef) throw new Error('DEEP_DISH_TARGET is required');

    const { runVisualDiff } = await import('../../dist-electron/visualDiff.js');
    const report = await runVisualDiff({
      repoPath,
      baseRef,
      targetRef,
      viewport: { width: 1280, height: 900 },
    });

    emit({
      ok: true,
      repoPath,
      baseRef,
      targetRef,
      totalRoutes: report.totalRoutes,
      changedRoutes: report.changedRoutes,
      durationMs: report.durationMs,
      routeStatuses: report.routes.map((route) => ({
        path: route.path,
        urlPath: route.urlPath,
        status: route.status,
        mismatchRatio: route.mismatchRatio,
        mismatchPixels: route.mismatchPixels,
        hasImages: Boolean(route.beforeImage && route.afterImage && route.diffImage),
        error: route.error,
      })),
    });
  } catch (error) {
    emit({
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
