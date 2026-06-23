/**
 * Capture preload — wired as `webPreferences.preload` (visual-diff capture
 * window) and the `<webview preload>` attribute (sidecar preview). Its only job
 * is to install the network-capture interceptor into the page's MAIN world as
 * early as possible (document-start), so it patches `fetch`/`XMLHttpRequest`
 * BEFORE the page fires its first request.
 *
 * Runs in the renderer's isolated world. The window is sandboxed
 * (`sandbox: true`), so Node APIs (fs, path) are unavailable here — the
 * interceptor IIFE is therefore EMBEDDED as a string at build time via esbuild
 * `define` (`__INTERCEPTOR_SOURCE__`), not read from disk. Only DOM APIs are
 * used, which sandboxed preloads do have.
 *
 * Excluded from `tsconfig.electron.json`; bundled to CJS by
 * `scripts/build-capture-inject.mjs`.
 */

// Replaced at build time with the bundled interceptor IIFE source (a string).
declare const __INTERCEPTOR_SOURCE__: string;

function injectIntoMainWorld(): boolean {
  const parent = document.documentElement ?? document.head ?? document.body;
  if (!parent) return false;
  const script = document.createElement('script');
  // Inline classic script → executes synchronously in the MAIN world on append.
  script.textContent = __INTERCEPTOR_SOURCE__;
  parent.appendChild(script);
  // The patch is installed once the script runs; the element is no longer needed.
  script.remove();
  return true;
}

if (!injectIntoMainWorld()) {
  // documentElement not parsed yet — inject the instant it appears, still before
  // any page <script> executes (the userscript @document-start pattern).
  const observer = new MutationObserver(() => {
    if (injectIntoMainWorld()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}
