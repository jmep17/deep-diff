/**
 * Builds the network-capture injection bundle used by the sidecar <webview> and
 * the visual-diff capture window.
 *
 * Two-stage, in-memory:
 *   1. Bundle electron/inject/captureInterceptor.ts → an IIFE (browser target,
 *      @mswjs/interceptors browser preset). Kept in memory, never written.
 *   2. Bundle electron/inject/capturePreload.ts → dist-electron/capture-preload.cjs,
 *      with the stage-1 IIFE embedded via esbuild `define` (__INTERCEPTOR_SOURCE__).
 *      The capture window is sandboxed, so the preload cannot read the IIFE off
 *      disk — it must be baked in as a string.
 *
 * Run from `build:electron` after `tsc` (the inject sources are excluded from
 * tsconfig.electron.json — they are browser code, not Node).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const interceptor = await build({
  entryPoints: [path.join(root, 'electron/inject/captureInterceptor.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  legalComments: 'none',
});
const interceptorSource = interceptor.outputFiles[0].text;

await build({
  entryPoints: [path.join(root, 'electron/inject/capturePreload.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  outfile: path.join(root, 'dist-electron/capture-preload.cjs'),
  define: { __INTERCEPTOR_SOURCE__: JSON.stringify(interceptorSource) },
  legalComments: 'none',
});

console.log(
  `[build-capture-inject] capture-preload.cjs built (interceptor ${interceptorSource.length} bytes embedded)`,
);
