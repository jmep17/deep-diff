#!/usr/bin/env node
/**
 * Standalone evidence script for the "Validate IPC inputs" ticket.
 *
 * Imports the compiled validators from dist-electron/ and asserts each
 * acceptance criterion directly. Requires `pnpm run build:electron` first.
 *
 * Usage:  node scripts/test-ipc-validation.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertGitRef,
  assertSafeCommand,
  assertAuthorizedRepoPath,
  requireNonEmptyString,
  validateGitHubBranchRequest,
  validateGitHubRepositoryRequest,
  validateSidecarLaunchRequest,
  validateVisualDiffRequest,
} from '../dist-electron/ipcValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(projectRoot, 'mock-repositories', 'auth0-routes-fixture');
const mockRoot = path.join(projectRoot, 'mock-repositories');

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
  failed++;
}

/** Asserts that `fn` throws an Error whose message contains `substring`. */
async function assertThrows(label, fn, substring) {
  try {
    await fn();
    fail(label, `Expected a throw but got none.`);
  } catch (err) {
    if (!(err instanceof Error)) {
      fail(label, `Threw a non-Error: ${String(err)}`);
      return;
    }
    if (substring && !err.message.includes(substring)) {
      fail(label, `Error message "${err.message}" did not contain "${substring}"`);
      return;
    }
    pass(label);
  }
}

/** Asserts that `fn` resolves without throwing. */
async function assertResolves(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// requireNonEmptyString
// ---------------------------------------------------------------------------
console.log('\n── requireNonEmptyString ──');

await assertThrows(
  'rejects non-string (number)',
  () => requireNonEmptyString(42, 'field'),
  'must be a string',
);
await assertThrows(
  'rejects non-string (null)',
  () => requireNonEmptyString(null, 'field'),
  'must be a string',
);
await assertThrows(
  'rejects empty string',
  () => requireNonEmptyString('', 'field'),
  'must not be empty',
);
await assertThrows(
  'rejects whitespace-only string',
  () => requireNonEmptyString('   ', 'field'),
  'must not be empty',
);
await assertResolves('accepts valid string', () => {
  const result = requireNonEmptyString('  hello  ', 'field');
  if (result !== 'hello') throw new Error(`Expected "hello", got "${result}"`);
});

// ---------------------------------------------------------------------------
// assertGitRef
// ---------------------------------------------------------------------------
console.log('\n── assertGitRef ──');

await assertThrows(
  'rejects leading dash (argument injection vector)',
  () => assertGitRef('-bad-ref', 'baseRef'),
  'must not start with "-"',
);
await assertThrows(
  'rejects NUL byte',
  () => assertGitRef('ref\0evil', 'baseRef'),
  'invalid characters',
);
await assertThrows(
  'rejects newline',
  () => assertGitRef('ref\nevil', 'baseRef'),
  'invalid characters',
);
await assertResolves('accepts normal branch name', () => assertGitRef('main', 'baseRef'));
await assertResolves('accepts feature branch with slash', () =>
  assertGitRef('feature/auth0-preview-callbacks', 'targetRef'),
);
await assertResolves('accepts working-tree sentinel', () =>
  assertGitRef('__working_tree__', 'baseRef'),
);

// ---------------------------------------------------------------------------
// assertSafeCommand
// ---------------------------------------------------------------------------
console.log('\n── assertSafeCommand ──');

await assertThrows(
  'rejects command injection via semicolon',
  () => assertSafeCommand('pnpm run dev; rm -rf /'),
  'not allowed',
);
await assertThrows(
  'rejects pipe',
  () => assertSafeCommand('pnpm run dev | cat /etc/passwd'),
  'not allowed',
);
await assertThrows(
  'rejects ampersand',
  () => assertSafeCommand('pnpm run dev && evil'),
  'not allowed',
);
await assertThrows(
  'rejects dollar sign',
  () => assertSafeCommand('pnpm run dev $HOME'),
  'not allowed',
);
await assertThrows('rejects backtick', () => assertSafeCommand('pnpm run `id`'), 'not allowed');
await assertThrows(
  'rejects unknown runner (sh)',
  () => assertSafeCommand('sh -c evil'),
  'not allowed',
);
await assertResolves("accepts 'pnpm run dev'", () => assertSafeCommand('pnpm run dev'));
await assertResolves("accepts 'npm run start'", () => assertSafeCommand('npm run start'));
await assertResolves("accepts 'yarn dev'", () => assertSafeCommand('yarn dev'));
await assertResolves("accepts 'npx next dev'", () => assertSafeCommand('npx next dev'));
await assertResolves("accepts 'node server.js'", () => assertSafeCommand('node server.js'));
await assertResolves("accepts 'bun run dev'", () => assertSafeCommand('bun run dev'));
await assertResolves('accepts script with colon (npm scripts)', () =>
  assertSafeCommand('pnpm run dev:server'),
);

// ---------------------------------------------------------------------------
// assertAuthorizedRepoPath
// ---------------------------------------------------------------------------
console.log('\n── assertAuthorizedRepoPath ──');

const emptyRoots = new Set();
const roots = new Set([mockRoot]);

await assertThrows(
  'rejects when no workspace authorized (empty roots)',
  () => assertAuthorizedRepoPath(fixturePath, emptyRoots),
  'No workspace has been authorized',
);
await assertThrows(
  'rejects non-existent path',
  () => assertAuthorizedRepoPath('/this/does/not/exist/at/all', roots),
  'does not exist',
);
await assertThrows(
  'rejects path outside authorized root',
  () => assertAuthorizedRepoPath('/tmp', roots),
  'not within an authorized workspace folder',
);
await assertThrows(
  'rejects path-traversal attempt (..)',
  () => assertAuthorizedRepoPath(fixturePath + '/../../../../../../etc', roots),
  'not within an authorized workspace folder',
);
await assertThrows(
  'rejects non-directory (a file, not a dir)',
  // package.json exists and is not a directory
  () => assertAuthorizedRepoPath(path.join(projectRoot, 'package.json'), new Set([projectRoot])),
  'not a directory',
);
await assertResolves('accepts valid path within authorized root', () =>
  assertAuthorizedRepoPath(fixturePath, roots),
);
await assertResolves('accepts root path itself', () => assertAuthorizedRepoPath(mockRoot, roots));

// ---------------------------------------------------------------------------
// validateGitHubRepositoryRequest
// ---------------------------------------------------------------------------
console.log('\n── validateGitHubRepositoryRequest ──');

await assertThrows(
  'rejects non-object',
  () => validateGitHubRepositoryRequest('bad'),
  'must be a plain object',
);
await assertThrows(
  'rejects missing organization',
  () => validateGitHubRepositoryRequest({}),
  'must be a string',
);
await assertThrows(
  'rejects empty organization',
  () => validateGitHubRepositoryRequest({ organization: '' }),
  'must not be empty',
);
await assertResolves('accepts valid request without token', () =>
  validateGitHubRepositoryRequest({ organization: 'acme' }),
);
await assertResolves('accepts valid request with token', () =>
  validateGitHubRepositoryRequest({ organization: 'acme', token: 'ghp_abc123' }),
);

// ---------------------------------------------------------------------------
// validateGitHubBranchRequest
// ---------------------------------------------------------------------------
console.log('\n── validateGitHubBranchRequest ──');

await assertThrows(
  'rejects missing owner',
  () => validateGitHubBranchRequest({ repository: 'repo' }),
  'must be a string',
);
await assertThrows(
  'rejects missing repository',
  () => validateGitHubBranchRequest({ owner: 'acme' }),
  'must be a string',
);
await assertResolves('accepts valid request', () =>
  validateGitHubBranchRequest({ owner: 'acme', repository: 'my-repo' }),
);

// ---------------------------------------------------------------------------
// validateSidecarLaunchRequest (async, uses authorized roots)
// ---------------------------------------------------------------------------
console.log('\n── validateSidecarLaunchRequest ──');

await assertThrows(
  'rejects when no workspace authorized',
  () => validateSidecarLaunchRequest({ repoPath: fixturePath, branch: 'main' }, emptyRoots),
  'No workspace has been authorized',
);
await assertThrows(
  'rejects path outside root',
  () => validateSidecarLaunchRequest({ repoPath: '/tmp' }, roots),
  'not within an authorized workspace folder',
);
await assertThrows(
  'rejects unsafe command',
  () =>
    validateSidecarLaunchRequest(
      { repoPath: fixturePath, branch: 'main', command: 'rm -rf /' },
      roots,
    ),
  'not allowed',
);
await assertThrows(
  'rejects leading-dash branch',
  () => validateSidecarLaunchRequest({ repoPath: fixturePath, branch: '-bad' }, roots),
  'must not start with "-"',
);
await assertResolves('accepts valid request without command', () =>
  validateSidecarLaunchRequest({ repoPath: fixturePath, branch: 'main' }, roots),
);
await assertResolves('accepts valid request with safe command', () =>
  validateSidecarLaunchRequest(
    { repoPath: fixturePath, branch: 'main', command: 'pnpm run dev' },
    roots,
  ),
);

// ---------------------------------------------------------------------------
// validateVisualDiffRequest (async, uses authorized roots)
// ---------------------------------------------------------------------------
console.log('\n── validateVisualDiffRequest ──');

const validDiffBase = {
  repoPath: fixturePath,
  baseRef: 'main',
  targetRef: 'feature/auth0-preview-callbacks',
};

await assertThrows(
  'rejects missing repoPath',
  () => validateVisualDiffRequest({ baseRef: 'main', targetRef: 'main' }, roots),
  'repoPath',
);
await assertThrows(
  'rejects leading-dash baseRef',
  () => validateVisualDiffRequest({ ...validDiffBase, baseRef: '-injection' }, roots),
  'must not start with "-"',
);
await assertThrows(
  'rejects unsafe command override',
  () => validateVisualDiffRequest({ ...validDiffBase, command: 'bash -c evil' }, roots),
  'not allowed',
);
await assertThrows(
  'rejects out-of-range mismatchTolerance',
  () => validateVisualDiffRequest({ ...validDiffBase, mismatchTolerance: 1.5 }, roots),
  'between 0 and 1',
);
await assertThrows(
  'rejects negative mismatchTolerance',
  () => validateVisualDiffRequest({ ...validDiffBase, mismatchTolerance: -0.1 }, roots),
  'between 0 and 1',
);
await assertThrows(
  'rejects non-number mismatchTolerance',
  () => validateVisualDiffRequest({ ...validDiffBase, mismatchTolerance: 'high' }, roots),
  'finite number',
);
await assertThrows(
  'rejects zero-width viewport',
  () => validateVisualDiffRequest({ ...validDiffBase, viewport: { width: 0, height: 900 } }, roots),
  'positive finite number',
);
await assertResolves('accepts valid minimal request', () =>
  validateVisualDiffRequest(validDiffBase, roots),
);
await assertResolves('accepts full valid request', () =>
  validateVisualDiffRequest(
    {
      ...validDiffBase,
      command: 'pnpm run dev',
      mismatchTolerance: 0.05,
      viewport: { width: 1280, height: 900 },
      routes: ['/', '/dashboard'],
    },
    roots,
  ),
);

// endpointOverrides: optional Record<string, Record<string, unknown>>
await assertThrows(
  'rejects endpointOverrides that is an array',
  () => validateVisualDiffRequest({ ...validDiffBase, endpointOverrides: [1, 2] }, roots),
  'plain object',
);
await assertThrows(
  'rejects endpointOverrides with non-object value',
  () =>
    validateVisualDiffRequest(
      { ...validDiffBase, endpointOverrides: { 'GET:/api/x': 'notobject' } },
      roots,
    ),
  'plain object',
);
await assertResolves('accepts valid endpointOverrides', () =>
  validateVisualDiffRequest(
    {
      ...validDiffBase,
      endpointOverrides: {
        'GET:/api/products/:productId': { id: 'prod_keyboard', price: 99 },
        'POST:/api/orders': { created: true },
      },
    },
    roots,
  ),
);
await assertResolves('accepts omitted endpointOverrides (undefined)', () =>
  validateVisualDiffRequest({ ...validDiffBase }, roots),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`Validation tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\nSome tests failed. See FAIL lines above.');
  process.exitCode = 1;
} else {
  console.log('\nAll acceptance criteria verified:');
  console.log('  ✓ Malformed/missing inputs return clear errors');
  console.log('  ✓ Path traversal and out-of-root paths are rejected');
  console.log('  ✓ Shell-metacharacter commands are rejected');
  console.log('  ✓ Valid inputs are accepted without error');
  console.log('  ✓ endpointOverrides validated as plain object of plain objects');
}
