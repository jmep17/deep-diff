# Repo overlays

Deep Diff captures a target app by checking each ref out into a throwaway `git worktree` and
spawning its dev server. Some apps can't be captured as-is — most commonly because a
**client-side auth SDK** (e.g. `@auth0/auth0-react` pointed at a real Auth0 domain) redirects
every route to an external login page before the page can render.

**Repo overlays** let you inject test-only files into that throwaway worktree **without touching
the target repository**. The files live only in Deep Diff's own app storage and are copied over
the worktree at capture time. They are never committed to your repo and never affect your own
`pnpm dev` or production build.

## Where the files go

Each repository gets its own overlay folder under the overlays root:

```
<overlays-root>/<repo-basename>-<8charhash>/
```

- `<overlays-root>` defaults to `<userData>/overlays` (platform app-data dir). Override with the
  `DEEP_DIFF_OVERLAY_ROOT` environment variable.
- The `-<8charhash>` suffix is derived from the repo's absolute path so two repos with the same
  folder name don't collide.
- Deep Diff creates this folder on the first sidecar launch / diff for the repo, drops an
  `OVERLAY-README.md` inside it (with the exact resolved path and a worked example), and logs the
  path. Look in the logs for `overlay:dir` to find the exact folder for your repo.

The overlay folder **mirrors the repo root**. Each file is copied to the same relative path in
the worktree, overwriting any existing file (whole-file replace, never merged):

```
<overlay>/vite.config.ts                  ->  <repo>/vite.config.ts
<overlay>/__mocks__/@auth0/auth0-react.ts ->  <repo>/__mocks__/@auth0/auth0-react.ts
```

`OVERLAY-README.md` is reserved and never copied into the worktree.

## Example: bypass a client-side Auth0 redirect

Drop a `vite.config.ts` that aliases the SDK to a mock, plus the mock itself. Because this config
only ever runs inside Deep Diff, the alias is unconditional (no env gate needed):

```ts
// <overlay>/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // import.meta.dirname (Node 20+); __dirname is undefined in a type:module config.
    alias: {
      '@auth0/auth0-react': resolve(import.meta.dirname, '__mocks__/@auth0/auth0-react.ts'),
    },
  },
});
```

```ts
// <overlay>/__mocks__/@auth0/auth0-react.ts
import React from 'react';
export const Auth0Provider = ({ children }: { children: React.ReactNode }) =>
  React.createElement(React.Fragment, null, children);
export const useAuth0 = () => ({
  isAuthenticated: true,
  isLoading: false,
  getAccessTokenSilently: async () => 'Token',
  user: { name: 'Mock User', email: 'mock@local' },
  loginWithRedirect: async () => {},
  logout: async () => {},
});
export const withAuthenticationRequired = (Component: unknown) => Component;
```

Match the exports/imports your app actually uses or it will throw on mount. The seam (alias →
mock stops the redirect and the protected route renders under Deep Diff's hidden window) is
proven by `scripts/test-auth-mock-seam.cjs`.

## Caveats

- **Whole-file overwrite, not merge.** Your overlay `vite.config.ts` must be a complete config
  valid for _both_ refs you compare; it replaces the app's config entirely. (A config-merge mode
  is the eventual improvement.)
- **Branch refs only.** Overlay applies to the throwaway worktree created for a branch/ref.
  Comparing the _working tree_ against a branch overlays only the branch side (false diff) — keep
  the files in your real checkout for that case, or compare two branches.
- **The mock stops the redirect; it doesn't fill the page.** Protected pages then fetch APIs with
  the stub token and those calls fail. To populate content, also configure Deep Diff endpoint
  mocks (the mock-override proxy) for those endpoints.

## Implementation

- `electron/repoOverlay.ts` — `overlayDirForRepo`, `applyOverlay`, `ensureOverlayScaffold`.
- `electron/main.ts` — resolves the overlays root and sets `overlayDir` on the launch/diff
  request after validation (never renderer-supplied).
- `electron/sidecar.ts` / `electron/visualDiff.ts` — apply the overlay inside
  `prepareRuntimeRepository`, after `git worktree add` and before dependency install.
- Tests: `scripts/test-repo-overlay.mjs` (plumbing), `scripts/test-auth-mock-seam.cjs` (auth seam).
