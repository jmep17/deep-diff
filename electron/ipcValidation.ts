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
  ChangedFilesRequest,
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

/**
 * Validates an endpoint-overrides map: a plain object whose keys are
 * "METHOD:path" strings and whose values are plain objects (body-only
 * replacement JSON). Returns a fresh, shape-checked copy. Shared by the
 * sidecar-launch, visual-diff, and live `sidecar:setOverrides` handlers.
 */
export function validateEndpointOverrides(raw: unknown): Record<string, Record<string, unknown>> {
  const outer = assertPlainObject(raw, 'endpointOverrides');
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const [key, body] of Object.entries(outer)) {
    overrides[key] = assertPlainObject(body, `endpointOverrides["${key}"]`);
  }
  return overrides;
}

export function validateGitHubRepositoryRequest(raw: unknown): GitHubRepositoryRequest {
  const obj = assertPlainObject(raw, 'github:listRepos request');
  return {
    organization: requireNonEmptyString(obj.organization, 'organization'),
  };
}

export function validateGitHubBranchRequest(raw: unknown): GitHubBranchRequest {
  const obj = assertPlainObject(raw, 'github:listBranches request');
  return {
    owner: requireNonEmptyString(obj.owner, 'owner'),
    repository: requireNonEmptyString(obj.repository, 'repository'),
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

  const endpointOverrides =
    obj.endpointOverrides !== undefined
      ? validateEndpointOverrides(obj.endpointOverrides)
      : undefined;

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
  const endpointOverrides =
    obj.endpointOverrides !== undefined
      ? validateEndpointOverrides(obj.endpointOverrides)
      : undefined;

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

/**
 * Validates a `changes:files` request: authorized repo path + two safe git refs
 * (each may be the working-tree sentinel "__working_tree__").
 */
export async function validateChangedFilesRequest(
  raw: unknown,
  roots: ReadonlySet<string>,
): Promise<ChangedFilesRequest> {
  const obj = assertPlainObject(raw, 'changes:files request');
  const repoPath = await assertAuthorizedRepoPath(obj.repoPath, roots);
  const baseRef = assertGitRef(obj.baseRef, 'baseRef');
  const targetRef = assertGitRef(obj.targetRef, 'targetRef');
  return { repoPath, baseRef, targetRef };
}

export interface ChangeLinkRequest extends ChangedFilesRequest {
  elements: {
    id: string;
    sourcePath: string;
    rect?: { x: number; y: number; width: number; height: number };
    tag?: string;
  }[];
}

const finiteOrZero = (value: unknown): number =>
  typeof value === 'number' && isFinite(value) ? value : 0;

/**
 * Validates a `changes:link` request: an authorized repo path + two safe git
 * refs, plus a sanitized list of probed DOM elements (id/sourcePath/rect/tag).
 * The element list comes from untrusted page DOM, so it is capped and coerced
 * to known shapes — it is only ever used for string path matching, never fs/exec.
 */
export async function validateChangeLinkRequest(
  raw: unknown,
  roots: ReadonlySet<string>,
): Promise<ChangeLinkRequest> {
  const base = await validateChangedFilesRequest(raw, roots);
  const obj = assertPlainObject(raw, 'changes:link request');
  const rawElements = Array.isArray(obj.elements) ? obj.elements : [];
  const elements = rawElements.slice(0, 5000).map((entry, index) => {
    const el = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const rawRect =
      el.rect && typeof el.rect === 'object' ? (el.rect as Record<string, unknown>) : undefined;
    return {
      id: typeof el.id === 'string' ? el.id : `el${index}`,
      sourcePath: typeof el.sourcePath === 'string' ? el.sourcePath : '',
      rect: rawRect
        ? {
            x: finiteOrZero(rawRect.x),
            y: finiteOrZero(rawRect.y),
            width: finiteOrZero(rawRect.width),
            height: finiteOrZero(rawRect.height),
          }
        : undefined,
      tag: typeof el.tag === 'string' ? el.tag : undefined,
    };
  });
  return { ...base, elements };
}

/**
 * Validates a `logs:append` payload from the renderer (a browser-console message
 * from the live sidecar preview <webview>). Shape only — `text` originates from
 * untrusted page output, so it is coerced and truncated rather than rejected.
 */
export function validateLogAppend(raw: unknown): { text: string; level?: string } {
  const obj = assertPlainObject(raw, 'logs:append request');
  const text = (typeof obj.text === 'string' ? obj.text : '').slice(0, 8192);
  const level = typeof obj.level === 'string' ? obj.level.slice(0, 32) : undefined;
  return { text, level };
}

/**
 * Validates a `logs:reveal` payload. Returns the requested file path; the handler
 * enforces that it resolves to a file inside the log directory before revealing it.
 */
export function validateLogReveal(raw: unknown): string {
  const obj = assertPlainObject(raw, 'logs:reveal request');
  return requireNonEmptyString(obj.file, 'file');
}
