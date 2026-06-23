# Fix note: `pages/index.*` maps to `/index` instead of `/`

## Symptom

For a Pages-Router-style app whose home route is `pages/index.jsx` (or `.tsx` /
`.js` / …), Deep Diff detects the route as **`/index`** instead of **`/`**.

Observed end-to-end while diffing the Vite + React target
[`jmep17/deep-diff-e2e-storefront`](https://github.com/jmep17/deep-diff-e2e-storefront):
the report listed `/index` (42% changed) rather than `/`. The diff still ran
correctly — the SPA dev server serves `index.html` for `/index` too, so the page
rendered — but the route label is wrong, and a real Pages-Router server would
likely 404 on `/index`.

It only affects the **top-level** index. Nested indexes already map right
(`pages/blog/index.jsx` → `/blog`), and the App Router home (`app/page.tsx`) is
handled by a separate, correct branch.

## Root cause

`electron/routeDetection.ts`, `pageRouteFromRelativePath`, the Pages-Router
branch (around line 108):

```ts
const pagesMatch = sourceFile.match(/^pages\/(.+)\.(tsx?|jsx?|mjs|cjs)$/);
if (pagesMatch && !pagesMatch[1].startsWith('api/')) {
  const segments = pagesMatch[1].replace(/\/index$/, '').split('/'); // <-- here
  return { ...routeFromSegments(segments), sourceFile };
}
```

For `pages/index.jsx`, `pagesMatch[1]` is `"index"`. The strip regex
`/\/index$/` requires a slash before `index`, so it matches `foo/index` but
**not** a bare `index`. The leftover `"index"` becomes a path segment, yielding
`/index`.

## Fix

Strip a leading-or-nested `index`, then map the now-empty path to root. The App
Router branch already returns `{ path: '/' }` for `app/page.tsx`, so this brings
Pages Router to parity.

```ts
const pagesMatch = sourceFile.match(/^pages\/(.+)\.(tsx?|jsx?|mjs|cjs)$/);
if (pagesMatch && !pagesMatch[1].startsWith('api/')) {
  const cleaned = pagesMatch[1].replace(/(^|\/)index$/, '');
  const segments = cleaned ? cleaned.split('/') : [];
  return { ...routeFromSegments(segments), sourceFile };
}
```

- `index` → `''` → `[]` → `routeFromSegments([])`.
- `blog/index` → `blog` → `['blog']` (unchanged behavior).

**Check first:** confirm `routeFromSegments([])` returns `{ path: '/', urlPath: '/' }`.
If it instead produces `/` from an empty-string segment, also guard the empty
case (e.g. return the `'/'` route directly when `cleaned === ''`).

## Verification

- Add a unit assertion (Cypress task or a `scripts/` check) that
  `pageRouteFromRelativePath('pages/index.jsx')` → `path === '/'`, and that
  `pages/blog/index.jsx` still → `/blog`.
- Re-run a diff against `deep-diff-e2e-storefront`: the report's home route should
  read `/` (not `/index`), with `/about` and `/contact` still byte-identical
  controls.
- Run `pnpm run test:scenarios` — the `mock-workspace` fixtures use `app/page.tsx`
  for home, so they should be unaffected (regression guard).
