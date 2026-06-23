import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// A README dropped inside each per-repo overlay folder to document what goes there.
// applyOverlay never copies it into the worktree (reserved name).
export const OVERLAY_README_NAME = 'OVERLAY-README.md';

function safeName(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

/**
 * Stable per-repository overlay folder name: human-readable basename plus a short hash
 * of the real path so two repos that share a basename don't collide on one folder.
 */
export function overlayKeyForRepo(repoPath: string) {
  const hash = createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 8);
  return `${safeName(path.basename(repoPath)) || 'repo'}-${hash}`;
}

/** Absolute path of the overlay folder for a repo under the given overlays root. */
export function overlayDirForRepo(overlaysRoot: string, repoPath: string) {
  return path.join(overlaysRoot, overlayKeyForRepo(repoPath));
}

async function listFilesRecursive(root: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Resolve a repo-relative overlay path to an absolute path confined to the repo's overlay
 * folder. Rejects absolute paths and `..` traversal that would escape the folder.
 */
function resolveOverlayChild(overlayDir: string, relPath: string): string {
  const target = path.resolve(overlayDir, relPath);
  const rootWithSep = overlayDir.endsWith(path.sep) ? overlayDir : overlayDir + path.sep;
  if (target !== overlayDir && !target.startsWith(rootWithSep)) {
    throw new Error('Path escapes overlay folder.');
  }
  return target;
}

/** List repo-relative overlay files (excluding the reserved README). [] if none. */
export async function listOverlayFiles(overlaysRoot: string, repoPath: string): Promise<string[]> {
  const dir = overlayDirForRepo(overlaysRoot, repoPath);
  try {
    const files = await listFilesRecursive(dir);
    return files.filter((rel) => rel !== OVERLAY_README_NAME).sort();
  } catch {
    return [];
  }
}

/** Read one overlay file's text content. */
export async function readOverlayFile(
  overlaysRoot: string,
  repoPath: string,
  relPath: string,
): Promise<string> {
  const target = resolveOverlayChild(overlayDirForRepo(overlaysRoot, repoPath), relPath);
  return fs.readFile(target, 'utf8');
}

/** Write one overlay file (creating parent dirs). The reserved README is not writable. */
export async function writeOverlayFile(
  overlaysRoot: string,
  repoPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  if (path.basename(relPath) === OVERLAY_README_NAME) {
    throw new Error('That file name is reserved.');
  }
  const target = resolveOverlayChild(overlayDirForRepo(overlaysRoot, repoPath), relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

/** Delete one overlay file. The reserved README is not deletable. */
export async function deleteOverlayFile(
  overlaysRoot: string,
  repoPath: string,
  relPath: string,
): Promise<void> {
  if (path.basename(relPath) === OVERLAY_README_NAME) {
    throw new Error('That file name is reserved.');
  }
  const target = resolveOverlayChild(overlayDirForRepo(overlaysRoot, repoPath), relPath);
  await fs.rm(target, { force: true });
}

/**
 * Copy the contents of `overlayDir` over `worktreePath`, mirroring the repo root and
 * overwriting existing files (whole-file, never merged). The overlay folder lives only in
 * Deep Diff's own storage and is applied only to throwaway capture worktrees, so it never
 * touches the user's real checkout or git history.
 *
 * No-op (returns []) when `overlayDir` is undefined, missing, or empty. Returns the list of
 * applied repo-relative paths for logging.
 */
export async function applyOverlay(
  worktreePath: string,
  overlayDir: string | undefined,
): Promise<string[]> {
  if (!overlayDir) return [];

  let found: string[];
  try {
    found = await listFilesRecursive(overlayDir);
  } catch {
    return []; // overlay dir does not exist
  }
  // Never copy the documentation file into the worktree.
  const applied = found.filter((rel) => rel !== OVERLAY_README_NAME);
  if (applied.length === 0) return [];

  for (const rel of applied) {
    const dest = path.join(worktreePath, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(overlayDir, rel), dest);
  }
  return applied;
}

function overlayReadme(repoLabel: string, overlayDir: string) {
  return `# Deep Diff overlay — ${repoLabel}

Files placed in **this folder** are copied over a throwaway checkout (git worktree) of this
repository each time Deep Diff captures it for a sidecar preview or a visual diff. They are
**never** committed to your repo and never reach your own \`pnpm dev\` or production — they
exist only here, in Deep Diff's app storage, and are applied only to disposable worktrees.

Use this to inject test-only config the captured app needs but that you don't want in your
git history — most commonly a dev auth bypass.

## Exactly where files go

This folder mirrors your **repository root**. A file here is copied to the same relative path
in the checkout, overwriting any existing file (whole-file replace — it is **not** merged):

    ${overlayDir}/vite.config.ts                     ->  <repo>/vite.config.ts
    ${overlayDir}/__mocks__/@auth0/auth0-react.ts    ->  <repo>/__mocks__/@auth0/auth0-react.ts

(\`${OVERLAY_README_NAME}\` — this file — is ignored and never copied.)

## Worked example: bypass a client-side Auth0 redirect

App uses \`@auth0/auth0-react\` with a real Auth0 domain, so every route redirects to log in
and the capture never reaches the page. Alias the SDK to a mock that reports "logged in".

\`vite.config.ts\` (alias unconditionally — this file only ever runs inside Deep Diff):

    import { defineConfig } from "vite";
    import react from "@vitejs/plugin-react";
    import { resolve } from "node:path";

    export default defineConfig({
      plugins: [react()],
      resolve: {
        alias: {
          "@auth0/auth0-react": resolve(import.meta.dirname, "__mocks__/@auth0/auth0-react.ts"),
        },
      },
    });

\`__mocks__/@auth0/auth0-react.ts\`:

    import React from "react";
    export const Auth0Provider = ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children);
    export const useAuth0 = () => ({
      isAuthenticated: true,
      isLoading: false,
      getAccessTokenSilently: async () => "Token",
      user: { name: "Mock User", email: "mock@local" },
      loginWithRedirect: async () => {},
      logout: async () => {},
    });
    export const withAuthenticationRequired = (Component: unknown) => Component;

Match the exports/imports your app actually uses, or the app throws on mount.

## Caveats

- **Whole-file overwrite, not merge.** Your overlay \`vite.config.ts\` must be a complete config
  valid for *both* branches you compare. It replaces the app's config entirely.
- **Works for branch refs.** Overlay applies to the throwaway worktree created for a branch/ref.
  If you compare the *working tree* against a branch, only the branch side is overlaid — keep
  the files in your real checkout for that case, or compare two branches.
- **The mock stops the redirect; it doesn't fill the page.** Protected pages then fetch APIs
  with the stub token and those calls fail (empty/error states). To populate content, also set
  endpoint mocks in Deep Diff (the mock-override proxy) for those endpoints.
`;
}

/**
 * Ensure the overlays root and this repo's overlay folder exist, and (re)write the in-folder
 * README documenting exactly what to put there and where. Returns the absolute overlay dir for
 * the repo. Electron-free: the caller resolves `overlaysRoot` (e.g. under userData).
 */
export async function ensureOverlayScaffold(
  overlaysRoot: string,
  repoPath: string,
): Promise<string> {
  const overlayDir = overlayDirForRepo(overlaysRoot, repoPath);
  await fs.mkdir(overlayDir, { recursive: true });
  await fs.writeFile(
    path.join(overlayDir, OVERLAY_README_NAME),
    overlayReadme(path.basename(repoPath), overlayDir),
    'utf8',
  );
  return overlayDir;
}
