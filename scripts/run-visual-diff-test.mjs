import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVisualDiff } from '../dist-electron/visualDiff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'mock-repositories', 'auth0-routes-fixture');

app.whenReady().then(async () => {
  try {
    const report = await runVisualDiff({
      repoPath: fixturePath,
      baseRef: 'main',
      targetRef: 'feature/auth0-preview-callbacks',
      viewport: { width: 1280, height: 900 },
    });

    console.log(
      JSON.stringify({
        ok: true,
        totalRoutes: report.totalRoutes,
        changedRoutes: report.changedRoutes,
        durationMs: report.durationMs,
        routePaths: report.routes.map((route) => route.path),
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
