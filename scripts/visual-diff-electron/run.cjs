// Generic headless Electron runner for runVisualDiff.
//
// Unlike scripts/electron-app/main.cjs (hard-wired to auth0-routes-fixture),
// this runner is parametrized so it can drive a visual diff against ANY repo.
//
// Inputs (env):
//   DEEP_DIFF_REPO   absolute path to the repo to diff (required)
//   DEEP_DIFF_BASE   base ref (default "main")
//   DEEP_DIFF_TARGET target ref (required)
//   DEEP_DIFF_OUT    file path to write the JSON report to (optional)
//
// It writes the report JSON to DEEP_DIFF_OUT (robust against stdout noise) and
// also prints a single JSON line to stdout.
const { app, protocol } = require('electron');
const fs = require('node:fs');

// Register the capture scheme before app `ready` so the visual-diff capture
// interceptor can report real bodies (mirrors what main.ts does in the app).
// Matches CAPTURE_SCHEME in electron/captureSink.ts.
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

const repoPath = process.env.DEEP_DIFF_REPO;
const baseRef = process.env.DEEP_DIFF_BASE || 'main';
const targetRef = process.env.DEEP_DIFF_TARGET;
const outPath = process.env.DEEP_DIFF_OUT;

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
    if (!repoPath) throw new Error('DEEP_DIFF_REPO is required');
    if (!targetRef) throw new Error('DEEP_DIFF_TARGET is required');

    const { runVisualDiff } = await import('../../dist-electron/visualDiff.js');
    const report = await runVisualDiff({
      repoPath,
      baseRef,
      targetRef,
      viewport: { width: 1280, height: 900 },
    });

    // Surface what the capture interceptor recorded during the run's pre-flight so
    // the scenario test can assert capture actually produced real bodies (a green
    // diff alone doesn't prove that — it only proves determinism held).
    const { getCaptures, captureCount } = await import('../../dist-electron/mockCapture.js');
    const capturedKeys = Object.keys(getCaptures());

    // Optionally dump before/after/diff PNGs for visual inspection.
    const imagesDir = process.env.DEEP_DIFF_IMAGES_DIR;
    if (imagesDir) {
      const path = require('node:path');
      fs.mkdirSync(imagesDir, { recursive: true });
      const toBuffer = (dataUrl) => Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64');
      const slug = (value) => value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
      for (const route of report.routes) {
        if (!route.beforeImage) continue;
        const base = `${slug(route.path)}__${route.status}`;
        fs.writeFileSync(path.join(imagesDir, `${base}__before.png`), toBuffer(route.beforeImage));
        fs.writeFileSync(path.join(imagesDir, `${base}__after.png`), toBuffer(route.afterImage));
        fs.writeFileSync(path.join(imagesDir, `${base}__diff.png`), toBuffer(route.diffImage));
      }
    }

    emit({
      ok: true,
      repoPath,
      baseRef,
      targetRef,
      totalRoutes: report.totalRoutes,
      changedRoutes: report.changedRoutes,
      capturedCount: captureCount(),
      capturedKeys,
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
