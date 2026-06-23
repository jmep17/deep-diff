import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

// Frozen install first (deterministic, no lockfile churn), then plain install as a
// fallback when the lockfile is stale/missing. The worktree is a disposable temp dir,
// so a mutating plain install there never touches the user's real checkout or lockfile.
const installCommands: Record<PackageManager, { frozen: string; fallback: string }> = {
  pnpm: { frozen: 'pnpm install --frozen-lockfile', fallback: 'pnpm install' },
  npm: { frozen: 'npm ci', fallback: 'npm install' },
  yarn: { frozen: 'yarn install --frozen-lockfile', fallback: 'yarn install' },
};

async function fileExists(filePath: string) {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

function runInstall(
  command: string,
  cwd: string,
  onData?: (text: string) => void,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // shell:true + inherited env so the package manager resolves on PATH exactly the
    // way the dev-server spawn resolves it (same mechanism, same resolution).
    const child = spawn(command, { cwd, env: process.env, shell: true });
    const chunks: string[] = [];
    const capture = (buf: Buffer) => {
      const text = buf.toString('utf8');
      onData?.(text); // stream live to the run log when a sink is wired
      chunks.push(text);
      if (chunks.length > 400) chunks.splice(0, chunks.length - 400);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (err) => resolve({ ok: false, output: `${command}: ${err.message}` }));
    // 'close' (not 'exit') so piped stdout/stderr are fully flushed before we read them.
    child.once('close', (code) => resolve({ ok: code === 0, output: chunks.join('') }));
  });
}

/**
 * Install dependencies in a freshly checked-out worktree before its dev server is spawned.
 * A `git worktree` has no `node_modules` (gitignored, never in history), so any repo with
 * real dependencies would otherwise crash on startup with "Cannot find module …".
 *
 * No-op when there is nothing to install (no deps declared) or `node_modules` already
 * exists — this keeps the zero-dependency test fixtures a true no-op (no pnpm/store/network).
 */
export async function installDependencies(
  repoPath: string,
  packageManager: PackageManager,
  onData?: (text: string) => void,
): Promise<void> {
  let packageJson: { dependencies?: unknown; devDependencies?: unknown };
  try {
    packageJson = JSON.parse(await fs.readFile(path.join(repoPath, 'package.json'), 'utf8'));
  } catch {
    return; // No package.json — nothing to install.
  }

  const hasDeps =
    (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) ||
    (packageJson.devDependencies && Object.keys(packageJson.devDependencies).length > 0);
  if (!hasDeps) return;

  if (await fileExists(path.join(repoPath, 'node_modules'))) return;

  const { frozen, fallback } = installCommands[packageManager];

  const frozenResult = await runInstall(frozen, repoPath, onData);
  if (frozenResult.ok) return;

  const fallbackResult = await runInstall(fallback, repoPath, onData);
  if (fallbackResult.ok) return;

  const tail = fallbackResult.output.split('\n').slice(-15).join('\n');
  throw new Error(
    `Failed to install dependencies in ${repoPath} with ${packageManager}.\n` +
      `Tried "${frozen}" then "${fallback}".\n${tail}`,
  );
}
