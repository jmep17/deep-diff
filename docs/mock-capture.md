# Automatic API capture → realistic mock generation

This note documents the network-capture feature: why it exists, why it is built
the way it is (including several non-obvious choices forced by empirical
testing), and exactly what every new and changed file does.

---

## 1. Why this exists

Deep Diff mocks every detected endpoint so a visual diff renders deterministic
data instead of hitting a live, changing backend. Before this feature, two things
were weak:

1. **Discovery was incomplete.** Endpoints came from (a) a static AST scan
   (`endpointScanner.ts`) that can only see _literal_ URLs, and (b) the always-on
   sidecar proxy, which records same-origin JSON responses but only those that
   fire during a session, and discards the body. URLs built from
   variables/`baseURL`/templates, and transport clients like tRPC/GraphQL, were
   invisible.
2. **Mock bodies were synthetic.** When the scanner couldn't infer fields from
   source, the mock was a placeholder `{ id: 'mock_001', status: 'ok' }`. Useless
   for a realistic regression image.

The requirement was: **every API call a target app makes should be discovered
automatically, and a valid mock generated automatically — by default**, with the
existing on/off toggle and per-mock editing preserved, and _no_ manual
"record / apply" step.

---

## 2. The approach, and why

### Runtime interception, not (only) static analysis

Static analysis can never guarantee "every call" — a URL assembled at runtime
(`fetch(\`${base}/users/${id}\`)`) has no literal to scan. The only way to catch
100% of the calls an app actually makes is to **observe the network layer at
runtime**. The static scan is kept as breadth (it lists endpoints that exist but
were never exercised); runtime interception is the completeness guarantee.

### Why in-page `fetch`/XHR interception (and not the alternatives)

| Option                                          | Rejected because                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CDP `webContents.debugger` Network domain**   | Documented Electron bugs intermittently drop events / fail `Network.getResponseBody` ([electron#37491](https://github.com/electron/electron/issues/37491), [#27768](https://github.com/electron/electron/issues/27768)). Unreliable bodies undermine "valid mocks." |
| **MITM proxy (`session.setProxy` + TLS CA)**    | Requires TLS man-in-the-middle and cert-trust management against arbitrary target repos. Heavyweight; in-page interception covers the `fetch`/XHR case that _is_ the use case.                                                                                      |
| **In-page `fetch` + `XMLHttpRequest` patch** ✅ | Catches every fired request regardless of how the URL was built, with reliable bodies. XHR coverage means **axios is covered** (axios rides XHR/fetch in the browser).                                                                                              |

### Three non-obvious constraints, each forced by an empirical failure

These were discovered by building a real Electron seam test
(`scripts/test-capture-interceptor.cjs`) and watching it fail, not by reasoning.
They are the load-bearing reasons the code looks the way it does — do not
"simplify" them away.

1. **The report channel must be a privileged custom scheme, not `webRequest` or a
   beacon.** The page reports each captured body to the host by POSTing it. The
   obvious host-side reader, `session.webRequest.onBeforeRequest`, exposes a
   fetch/XHR POST body only as `uploadData = [{ type, blobUUID, dataPipe }]` — an
   opaque blob handle, **not bytes**. `navigator.sendBeacon(Blob)` is the same.
   The only channel that reliably exposes the body is a **privileged custom
   scheme** (`dds-capture://`) handled by `protocol.handle`, where the handler
   reads `await request.text()`. Verified: capture count was `0` via `webRequest`,
   `5` via the scheme.

2. **`@mswjs/interceptors` corrupts JSON XHR bodies, so the interceptor is
   hand-rolled.** The industry-standard interceptor library builds its observed
   `Response` from `xhr.response`. For a `responseType: 'json'` XHR — **axios's
   default** — `xhr.response` is the already-parsed object, and
   `new Response(object)` stringifies it to the literal `"[object Object]"`. We
   read the body per `responseType` instead (`responseText` for text, re-serialize
   `xhr.response` for json). The dependency was added, proven to bundle, then
   removed once the hand-roll was needed.

3. **Strict CSP blocks the injection, so CSP is stripped on the capture session.**
   The interceptor installs by injecting an inline `<script>` into the page's main
   world. A target sending `Content-Security-Policy: script-src 'self'` (no
   `'unsafe-inline'`) **blocks that script outright** → the interceptor never
   installs → capture silently yields nothing. This affects a large class of real
   React/Vite/Next apps. We strip CSP response headers on the dedicated capture
   sessions via `onHeadersReceived`. Verified: capture count dropped to `0` under
   strict CSP, back to `5` after stripping.

---

## 3. Architecture at a glance

```
                ┌─ static AST scan (endpointScanner.ts) ── breadth: rows for never-fired endpoints
 inventory ◄────┤
 (endpoints)    └─ runtime capture (in-page interceptor) ── completeness: every fired call + real body
                                 │
  injected interceptor  (electron/inject/captureInterceptor.ts, main world)
   ├─ visual-diff capture window  (webPreferences.preload)
   └─ sidecar <webview>           (preload force-injected by main.ts will-attach-webview)
                                 │  POST {method,url,pathname,status,contentType,body}
                                 ▼  to dds-capture://capture/record
  captureSink.ts: protocol.handle('dds-capture') + onHeadersReceived (CSP strip)
                                 ▼
  mockCapture.ts: recordCapture → sanitize → Map<"METHOD:path", JSON> + captureBus
                                 ▼
   ├─ captureBus 'endpoint' → main.ts → webContents.send('endpoints:observed') → renderer inventory
   └─ getCaptures() → visualDiff pre-flight freezes overrides served to both sides

  serve mocks (unchanged engine): sidecar proxy / visualDiff protocol.handle
  precedence:  user mockEdits  >  captured real body  >  synthetic fallback
```

Two timing rules make this work without breaking anything:

- **Install before the first request.** The interceptor is delivered by a
  _preload_, so it patches `fetch`/XHR before any page script runs. The seam test
  proves a fetch fired by the page's first inline `<script>` is still caught.
- **Capture before the comparison.** In a visual diff, `runVisualDiff` runs a
  **capture pre-flight** (load each route on the base server, mocks off) _before_
  the base/target screenshot loop, then freezes the override set. This is what
  lets the very first (cold) diff render with real data, while keeping base and
  target byte-identical (they serve the same frozen set).

---

## 4. New files

### `electron/inject/captureInterceptor.ts`

The code injected into each captured page's **main world**. Hand-rolled,
dependency-free, observe-only.

- Captures the pristine `window.fetch` before patching and reports through it, so
  its own report POSTs are never re-observed.
- Wraps `window.fetch`: returns the original promise untouched; on resolution, if
  the response is 2xx with a JSON `content-type`, reads `response.clone().text()`
  and reports it. Cloning means the page's response stream is never disturbed.
- Wraps `XMLHttpRequest.prototype.open`/`send`: stashes method+url on `open`, and
  on `loadend` reads the body **per `responseType`** (the `@mswjs/interceptors`
  bug above) and reports it.
- `report()` POSTs `{method,url,pathname,status,contentType,body}` (body = raw
  JSON text) to `dds-capture://capture/record` with `mode:'no-cors'` (a simple
  request — no preflight; the opaque response is ignored, the body still reaches
  the host).
- Idempotent: an `install()` guard (`window.__ddsCaptureInstalled`) means the
  belt-and-suspenders re-injection on SPA navigation can't double-patch.
- Every path is wrapped in `try/catch` returning silently — **capture must never
  break the page it observes**.

Browser-targeted (DOM globals); excluded from the Node tsconfig and bundled to an
IIFE.

### `electron/inject/capturePreload.ts`

The preload that installs the interceptor. Runs in the renderer's _isolated_
world, so to patch the page's (main-world) `fetch` it injects the interceptor as
an inline `<script>` element at document-start, with a `MutationObserver`
fallback for when `document.documentElement` isn't parsed yet (the userscript
`@document-start` pattern). The capture window is sandboxed, so the preload cannot
read the IIFE off disk — the bundled IIFE is **embedded as a string at build
time** via esbuild `define` (`__INTERCEPTOR_SOURCE__`). Only DOM APIs are used,
which sandboxed preloads have.

### `electron/mockCapture.ts`

The capture buffer. Electron-free (like `serverLogs.ts`) so the pure-Node
integration scripts can drive it.

- `recordCapture(method, pathname, status, contentType, body)` — gated on a 2xx
  JSON object/array body; collapses the path with the shared
  `collapseDynamicSegments`; keys it `METHOD:path`; **sanitizes** the body
  (earliest point, since capture is always-on); stores it. On a _new_ key it emits
  `captureBus('endpoint', buildObservedEndpoint(method, path, body))` so the
  inventory gets a row carrying the real body. The freshest body always wins
  (re-captures update the stored value silently).
- `getCaptures()` / `clearCaptures()` / `captureCount()` — the override map, reset,
  and size, consumed by the diff pre-flight and the tests.

### `electron/sanitize.ts`

PII redaction, applied at record time — the _sole_ privacy guard, because capture
is always-on (no opt-in) and captured bodies cross IPC and persist. Recursively
redacts sensitive-keyed values (`email|phone|token|password|secret|ssn|card|auth|cookie`)
and email/phone patterns inside strings; handles objects, **top-level arrays**,
and primitives. Intentionally over-redacts (a key named `author` matches `auth`) —
shape is preserved, safety beats realism. Electron-free.

### `electron/captureSink.ts`

The Electron-coupled bridge between the injected interceptor and the buffer.

- `registerCaptureScheme()` — registers `dds-capture` as a privileged scheme
  (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `bypassCSP`). **Must run
  before the app `ready` event** (scheme privileges lock in at startup).
- `attachCaptureSink(session)` — attaches, to a session that renders captured
  pages, (a) `onHeadersReceived` that **strips `content-security-policy[-report-only]`**
  (constraint #3), and (b) `protocol.handle('dds-capture')` that parses the report
  envelope, `JSON.parse`s the body, and calls `recordCapture`. Both are wrapped so
  a double-attach is a no-op.

### `scripts/build-capture-inject.mjs`

Two-stage in-memory esbuild, run from `build:electron` after `tsc`:

1. Bundle `captureInterceptor.ts` → an IIFE (browser target). Kept in memory.
2. Bundle `capturePreload.ts` → `dist-electron/capture-preload.cjs`, with the
   stage-1 IIFE baked in via `define: { __INTERCEPTOR_SOURCE__: JSON.stringify(...) }`.

### `scripts/test-capture-interceptor.cjs` (`pnpm run test:capture-interceptor`)

End-to-end test of the capture pipeline through the **real** `captureSink` +
`mockCapture` modules, under a strict CSP (`script-src 'self'`, a permanent
regression guard). A real `BrowserWindow` with the capture preload loads a page
that fires a fetch from its first inline script, a `responseType:'json'` XHR (the
axios case), a fetch returning a top-level array, and a fetch after a full
navigation. Asserts all land in `getCaptures()` with correct bodies, that the
array survives as an array, that an `email` field is redacted, and `captureCount`.

### `scripts/test-capture-webview.cjs` (`pnpm run test:capture-webview`)

Capture test for the **sidecar `<webview>`** surface specifically — the one path
whose preload is _force-injected_ by the host (`will-attach-webview`) rather than
set on a `BrowserWindow`. Replicates that wiring and proves a fetch fired inside
the guest `<webview>`, under strict CSP, is captured.

---

## 5. Changed files

### `electron/overrideMatcher.ts`

- Added `MockBody` (`= unknown`) — a captured/mock body is now any JSON value, so
  **top-level arrays** (list endpoints) are first-class. `EndpointOverrides` and
  `matchOverride`'s return type use it.
- Moved `collapseDynamicSegments` here from `sidecar.ts` and **exported** it. This
  is the cycle-free shared home (it imports nothing from sidecar/scanner). Both the
  proxy's runtime discovery and `mockCapture` now derive keys from the _identical_
  function, so a captured body attaches to the discovered/scanned endpoint of the
  same key. Folded in a slug rule (`>8 chars containing a digit → :id`) for
  non-numeric/non-UUID ids; it is a no-op when no such segment exists.

### `electron/endpointScanner.ts`

`buildObservedEndpoint` now takes an optional `mock` body. When given, the row's
`mock` is the real captured body and its framework is tagged `observed (captured)`
(vs `observed (runtime)` for body-less proxy discovery) — the renderer uses that
tag to decide whether to upgrade an existing synthetic mock.

### `electron/sidecar.ts`

Imports the shared `collapseDynamicSegments` (local copy removed) and calls
`clearCaptures()` on launch, alongside the existing `observedEndpoints.clear()`.
The proxy itself is unchanged — sidecar capture flows through the `<webview>`
interceptor + the scheme sink, not the proxy.

### `electron/visualDiff.ts`

The substantive diff-side work:

- `createCaptureWindow` sets `webPreferences.preload = CAPTURE_PRELOAD`.
- `runVisualDiff` calls `clearCaptures()` at the start and
  `attachCaptureSink(captureWindow.webContents.session)` after creating the window.
- **Capture pre-flight** (`preflightCaptureRoutes`): before the base/target loop,
  loads each route once on the base server with no mocks so the interceptor records
  real bodies.
- **Frozen-override merge**: `overrides = { ...getCaptures() }`, then for each
  entry in `request.endpointOverrides`, the request body wins only if the key is a
  user edit (`userMockKeys`) or has no capture. Net precedence: **user edit >
  captured real > request synthetic**. The set is frozen and served identically to
  both sides — the determinism invariant.
- Emits a log line stating how many bodies the pre-flight captured (or that it
  captured none), so a silent no-op is visible rather than masquerading as success.
- The mock-serving `protocol.handle('http')` is otherwise unchanged (it is _not_
  un-gated — capture is the interceptor's job, serving is the handler's).
- Removed an unused `session` import.

### `electron/main.ts`

- `registerCaptureScheme()` at module load (before `ready`).
- `will-attach-webview` now **forces** `webPreferences.preload = CAPTURE_PRELOAD`
  (a main-process path, never renderer-supplied) instead of deleting the preload —
  more secure (the renderer still cannot inject an arbitrary preload) and it
  installs the interceptor in the sidecar preview.
- `attachCaptureSink(session.fromPartition('sidecar-preview'))` and a `captureBus`
  subscription that forwards captured endpoints over the existing
  `endpoints:observed` channel.

### `electron/types.ts`, `src/lib/types.ts`, `src/vite-env.d.ts`, `electron/preload.ts`

Mirror the `MockBody` widening across the two process type-worlds:
`EndpointDefinition.mock`, `mockEdits`, and the override-map signatures are now
JSON-value-typed. `VisualDiffRequest` gains `userMockKeys?: string[]`.

### `electron/ipcValidation.ts`

`validateEndpointOverrides` now accepts any JSON **object or array** value
(`assertJsonValue`) instead of only plain objects — a primitive is still rejected.
`validateVisualDiffRequest` validates the new optional `userMockKeys` string array.

### `src/App.tsx`

- The `endpoints:observed` listener now **upgrades** an existing endpoint's
  synthetic mock to a freshly captured real body — but only when the incoming row
  is tagged `observed (captured)` and the user hasn't edited that key (their edit
  always wins). A body-less proxy-discovery hit never clobbers a richer row.
- The visual-diff call passes `userMockKeys: Object.keys(mockEdits)`.
- The mock editor (`MockBodyEditor`) accepts a JSON object **or array**.
- Mock-body types widened to `MockBody`. No "record/apply" UI — capture and
  population are automatic.

### Build / test glue

- `package.json` — `build:electron` runs `build-capture-inject.mjs`; new
  `test:capture-interceptor` and `test:capture-webview` scripts.
- `tsconfig.electron.json` — excludes `electron/inject/**` (browser code, bundled
  by esbuild, not the Node tsc build).
- `scripts/visual-diff-electron/run.cjs` — registers the capture scheme (so
  `test:scenarios` exercises capture) and emits `capturedCount` / `capturedKeys`.
- `scripts/test-scenario-repos.mjs` — asserts `capturedCount > 0`, proving capture
  produces real bodies on a real diff (a green diff alone only proves determinism).
- `scripts/test-ipc-validation.mjs` — updated for the widened override contract
  (array bodies accepted, primitives rejected).

---

## 6. Determinism and precedence

The hard invariant: in a diff run, base and target must receive **byte-identical**
responses per call, or control routes false-positive (`mismatchRatio 0`). This
holds because:

1. Capture happens in the **pre-flight**, before the base/target loop.
2. The override set is then **frozen** and served identically to both sides.
3. During the screenshot loop the interceptor is **observe-only** — it never flips
   a call from real→mock mid-loop.

Control routes stay identical whether the served body is captured-real (== the
real response) or synthetic (same value both sides). `test:scenarios` proves both
properties simultaneously: controls at `mismatchRatio 0` **and**
`capturedCount > 0`.

---

## 7. Security and privacy

- **PII** is scrubbed at record time (`sanitize.ts`) — the earliest point, before
  any IPC or persistence.
- **CSP stripping** is scoped to the dedicated capture sessions only (never the
  main app window). Those pages are already sandboxed, context-isolated,
  `nodeIntegration:false`, window-open-denied, and confined to localhost, so
  removing CSP only enables our observer injection. Trade-off: a CSP-using target
  renders here without CSP — visually neutral for the app's own resources, and
  applied equally to base+target so the diff stays valid.
- **The capture scheme** is registered privileged but is internal; the page can
  POST to it but the report handler only ever records data.
- **The webview preload is main-process-controlled**, never renderer-supplied.

---

## 8. Verification

| Test                                                                         | Proves                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `typecheck`, `eslint`                                                        | types consistent across both processes; no lint errors                        |
| `test:capture-interceptor`                                                   | full pipeline incl. json-XHR, array body, PII redaction, **under strict CSP** |
| `test:capture-webview`                                                       | the sidecar `<webview>` force-injected preload path                           |
| `test:scenarios`                                                             | capture-active determinism (`mismatchRatio 0`) **and** `capturedCount > 0`    |
| `test:mock-rendering`                                                        | a mock visibly changes the rendered page (serving unchanged)                  |
| `test:sidecar-mocks`                                                         | proxy serving + discovery keys unchanged by the slug fold-in                  |
| `test:ipc`                                                                   | widened override validation (arrays accepted, primitives rejected)            |
| `test:scan-calls`, `test:live-mocks`, `test:change-link`, Cypress `test:e2e` | no regressions                                                                |

---

## 9. Limitations / deferred

- **Cross-origin mock _serving_** is deferred. The interceptor _discovers and
  captures_ cross-origin calls (whose bodies are readable), but mocks are served by
  the same-origin proxy / `protocol.handle('http')`. Serving cross-origin/HTTPS
  would require the interceptor itself to respond (MSW-style) — a separate phase.
- **Opaque `no-cors` cross-origin responses** can't be read in-page (a hard browser
  limit), so their bodies aren't captured.
- **Static detection of RTK Query / GraphQL / tRPC** isn't added — runtime capture
  catches anything that fires, so it's low urgency.
- **Capture is best-effort.** Any failure mode degrades to synthetic mocks; the
  per-run log line surfaces when a run captured nothing.
