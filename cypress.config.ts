import { defineConfig } from 'cypress';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { scanEndpoints } from './electron/endpointScanner';
import { detectVisualRoutesForChangedFiles, scanVisualRoutes } from './electron/routeDetection';

const e2ePort = process.env.DEEP_DISH_E2E_PORT ?? '5174';
const execFileAsync = promisify(execFile);
const fixturePath = path.join(process.cwd(), 'mock-repositories', 'auth0-routes-fixture');

export default defineConfig({
  allowCypressEnv: false,
  e2e: {
    baseUrl: `http://127.0.0.1:${e2ePort}`,
    supportFile: 'cypress/support/e2e.ts',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    viewportWidth: 1440,
    viewportHeight: 960,
    video: false,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 10_000,
    setupNodeEvents(on, config) {
      on('task', {
        log(message: string) {
          console.log(message);
          return null;
        },
        async scanFixtureEndpoints() {
          return scanEndpoints(fixturePath);
        },
        async detectVisualRoutesForFiles({ changedFiles }: { changedFiles: string[] }) {
          const allRoutes = await scanVisualRoutes(fixturePath);
          return detectVisualRoutesForChangedFiles(fixturePath, changedFiles, allRoutes);
        },
        async detectFixtureChangedRoutes({
          baseRef,
          targetRef,
        }: {
          baseRef: string;
          targetRef: string;
        }) {
          const { stdout } = await execFileAsync('git', [
            '-C',
            fixturePath,
            'diff',
            '--name-only',
            `${baseRef}..${targetRef}`,
          ]);
          const changedFiles = stdout
            .split('\n')
            .map((file) => file.trim())
            .filter(Boolean);
          const allRoutes = await scanVisualRoutes(fixturePath);
          const routes = detectVisualRoutesForChangedFiles(fixturePath, changedFiles, allRoutes);

          return { changedFiles, routes };
        },
      });

      return config;
    },
  },
});
