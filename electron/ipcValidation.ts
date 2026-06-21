/**
 * IPC input validators for the Electron main process.
 *
 * All validators throw `Error` with specific, clear messages on invalid input.
 * They are pure (or nearly so) — the only async one, `assertAuthorizedRepoPath`,
 * reads the real filesystem path via `fs.realpath`/`fs.stat`.
 *
 * These validators live at the IPC-handler boundary in `main.ts` only.
 * They are NOT imported into core modules (sidecar.ts, visualDiff.ts, etc.)
 * so that direct-call integration scripts bypass validation as expected.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  GitHubBranchRequest,
  GitHubRepositoryRequest,
  SidecarLaunchRequest,
  VisualDiffRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

/** Asserts that `value` is a non-empty string. Returns the trimmed value. */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string (got ${typeof value}).`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

/**
 * Validates a git ref: non-empty, no leading dash (argument-injection vector),
 * no NUL bytes or newlines.  Allows the working-tree sentinel "__working_tree__".
 */
export function assertGitRef(ref: unknown, field: string): string {
  const s = requireNonEmptyString(ref, field);
  if (s.startsWith('-')) {
    throw new Error(`${field} must not start with "-" (got "${s}").`);
  }
  if (s.includes('\0') || s.includes('\n') || s.includes('\r')) {
    throw new Error(`${field} contains invalid characters (NUL or newline).`);
  }
  return s;
}

/**
 * Validates a dev-server command override.
 * Must start with a known runner (npm, pnpm, yarn, npx, node, bun) and
 * may only contain word characters, spaces/tabs, and safe punctuation.
 * Shell metacharacters (;  |  &  $  `  >  <  (  )  and newlines) are rejected.
 */
// Word chars + space + tab + . / @ : = -  (no shell metacharacters)
const SAFE_COMMAND_RE = /^(npm|pnpm|yarn|npx|node|bun)\b[\w \t./@:=-]*$/;

export function assertSafeCommand(command: unknown): string {
  const s = requireNonEmptyString(command, 'command');
  if (!SAFE_COMMAND_RE.test(s)) {
    throw new Error(
      `command is not allowed. Commands must start with npm, pnpm, yarn, npx, node, or bun ` +
        `and may not contain shell metacharacters (; | & $ \` > < ( ) or newlines).`,
    );
  }
  return s;
}

/**
 * Validates that `repoPath` refers to an existing directory that is at or
 * under one of the user-authorized workspace roots.
 *
 * Uses `fs.realpath` to resolve symlinks so that symlink-escape attacks are
 * caught: a symlink inside an authorized root that points outside is rejected.
 *
 * Throws if:
 * - no workspace has been authorized yet (roots is empty)
 * - the path does not exist or cannot be resolved
 * - the resolved path is not a directory
 * - the resolved path is not within any authorized root
 */
export async function assertAuthorizedRepoPath(
  repoPath: unknown,
  roots: ReadonlySet<string>,
): Promise<string> {
  const raw = requireNonEmptyString(repoPath, 'repoPath');

  if (roots.size === 0) {
    throw new Error('No workspace has been authorized. Please open a workspace folder first.');
  }

  let real: string;
  try {
    real = await fs.realpath(raw);
  } catch {
    throw new Error(`repoPath "${raw}" does not exist or cannot be resolved.`);
  }

  let statResult: Awaited<ReturnType<typeof fs.stat>>;
  try {
    statResult = await fs.stat(real);
  } catch {
    throw new Error(`repoPath "${raw}" does not exist.`);
  }
  if (!statResult.isDirectory()) {
    throw new Error(`repoPath "${raw}" is not a directory.`);
  }

  const sep = path.sep;
  const authorized = [...roots].some((root) => real === root || real.startsWith(root + sep));
  if (!authorized) {
    throw new Error(`repoPath "${raw}" is not within an authorized workspace folder.`);
  }

  return real;
}

// ---------------------------------------------------------------------------
// Composite request validators
// ---------------------------------------------------------------------------

function assertPlainObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a plain object.`);
  }
  return raw as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNonEmptyString(value, field);
}

export function validateGitHubRepositoryRequest(raw: unknown): GitHubRepositoryRequest {
  const obj = assertPlainObject(raw, 'github:listRepos request');
  return {
    organization: requireNonEmptyString(obj.organization, 'organization'),
    token: optionalString(obj.token, 'token'),
  };
}

export function validateGitHubBranchRequest(raw: unknown): GitHubBranchRequest {
  const obj = assertPlainObject(raw, 'github:listBranches request');
  return {
    owner: requireNonEmptyString(obj.owner, 'owner'),
    repository: requireNonEmptyString(obj.repository, 'repository'),
    token: optionalString(obj.token, 'token'),
  };
}

export async function validateSidecarLaunchRequest(
  raw: unknown,
  roots: ReadonlySet<string>,
): Promise<SidecarLaunchRequest> {
  const obj = assertPlainObject(raw, 'sidecar:launch request');
  const repoPath = await assertAuthorizedRepoPath(obj.repoPath, roots);
  const branch = obj.branch !== undefined ? assertGitRef(obj.branch, 'branch') : undefined;
  const command = obj.command !== undefined ? assertSafeCommand(obj.command) : undefined;

  let endpointOverrides: Record<string, Record<string, unknown>> | undefined;
  if (obj.endpointOverrides !== undefined) {
    const outer = assertPlainObject(obj.endpointOverrides, 'endpointOverrides');
    endpointOverrides = {};
    for (const [key, body] of Object.entries(outer)) {
      endpointOverrides[key] = assertPlainObject(body, `endpointOverrides["${key}"]`);
    }
  }

  return { repoPath, branch, command, endpointOverrides };
}

export async function validateVisualDiffRequest(
  raw: unknown,
  roots: ReadonlySet<string>,
): Promise<VisualDiffRequest> {
  const obj = assertPlainObject(raw, 'diff:run request');
  const repoPath = await assertAuthorizedRepoPath(obj.repoPath, roots);
  const baseRef = assertGitRef(obj.baseRef, 'baseRef');
  const targetRef = assertGitRef(obj.targetRef, 'targetRef');
  const command = obj.command !== undefined ? assertSafeCommand(obj.command) : undefined;

  // mismatchTolerance: optional finite number in [0, 1]
  let mismatchTolerance: number | undefined;
  if (obj.mismatchTolerance !== undefined) {
    if (typeof obj.mismatchTolerance !== 'number' || !isFinite(obj.mismatchTolerance)) {
      throw new Error('mismatchTolerance must be a finite number.');
    }
    if (obj.mismatchTolerance < 0 || obj.mismatchTolerance > 1) {
      throw new Error('mismatchTolerance must be between 0 and 1.');
    }
    mismatchTolerance = obj.mismatchTolerance;
  }

  // viewport: optional { width: number; height: number }
  let viewport: { width: number; height: number } | undefined;
  if (obj.viewport !== undefined) {
    const vp = assertPlainObject(obj.viewport, 'viewport');
    if (typeof vp.width !== 'number' || !isFinite(vp.width) || vp.width <= 0) {
      throw new Error('viewport.width must be a positive finite number.');
    }
    if (typeof vp.height !== 'number' || !isFinite(vp.height) || vp.height <= 0) {
      throw new Error('viewport.height must be a positive finite number.');
    }
    viewport = { width: vp.width, height: vp.height };
  }

  // routes: optional string[]
  let routes: string[] | undefined;
  if (obj.routes !== undefined) {
    if (!Array.isArray(obj.routes)) {
      throw new Error('routes must be an array.');
    }
    routes = (obj.routes as unknown[]).map((r, i) => requireNonEmptyString(r, `routes[${i}]`));
  }

  // endpointOverrides: optional plain object whose values are plain objects
  // (outer key = "METHOD:path", inner value = body-only replacement JSON)
  let endpointOverrides: Record<string, Record<string, unknown>> | undefined;
  if (obj.endpointOverrides !== undefined) {
    const outer = assertPlainObject(obj.endpointOverrides, 'endpointOverrides');
    endpointOverrides = {};
    for (const [key, body] of Object.entries(outer)) {
      endpointOverrides[key] = assertPlainObject(body, `endpointOverrides["${key}"]`);
    }
  }

  return {
    repoPath,
    baseRef,
    targetRef,
    command,
    mismatchTolerance,
    viewport,
    routes,
    endpointOverrides,
  };
}
