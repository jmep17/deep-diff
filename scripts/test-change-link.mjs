#!/usr/bin/env node
// TDD unit test for the change-link core (electron/changeLink.ts).
//
// Covers the deterministic, browser-free pieces of the code-change -> on-page
// element linking feature:
//   - getChangedFiles: git diff --name-only between two refs (and the
//     __working_tree__ sentinel) against the real storefront-auth0 scenario repo
//   - cleanSourcePath: normalize a raw DOM-derived source string (React fiber
//     fileName / data-* attr) down to a comparable path
//   - matchElementSource: does a cleaned element source map to a changed file?
//   - buildChangeLinks: filter a list of probed elements to the changed ones
//
// Requires dist-electron/ to be built first (pnpm run build:electron).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getChangedFiles,
  cleanSourcePath,
  matchElementSource,
  buildChangeLinks,
} from '../dist-electron/changeLink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const storefront = path.join(projectRoot, 'mock-workspace', 'storefront-auth0');
const featureBranch = 'feature/holiday-storefront-redesign';

let failures = 0;
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}
const sorted = (a) => [...a].sort();
const eq = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

async function main() {
  // --- getChangedFiles: the holiday redesign changes the home and product-detail
  // pages (server.mjs renders them; the matching app/*.tsx sources also differ so
  // the change-element highlighter has changed-file elements to mark), plus
  // fixture-expectations.json. The control pages' sources are NOT in the diff.
  const changed = await getChangedFiles(storefront, 'main', featureBranch);
  assert(
    eq(changed, [
      'app/page.tsx',
      'app/products/[productId]/page.tsx',
      'fixture-expectations.json',
      'server.mjs',
    ]),
    'getChangedFiles main..feature',
    JSON.stringify(changed),
  );
  assert(
    !changed.includes('app/account/page.tsx'),
    'getChangedFiles excludes an unchanged control page (app/account/page.tsx)',
  );

  // --- working-tree sentinel: clean checkout => no changes vs HEAD
  const wt = await getChangedFiles(storefront, 'main', '__working_tree__');
  assert(Array.isArray(wt), 'getChangedFiles __working_tree__ returns array', JSON.stringify(wt));

  // --- cleanSourcePath: strip wrappers, query, and :line:col
  const cleanCases = [
    ['webpack-internal:///./server.mjs', 'server.mjs'],
    ['./app/page.tsx', 'app/page.tsx'],
    ['server.mjs:42:7', 'server.mjs'],
    ['app/page.tsx?foo=bar', 'app/page.tsx'],
    ['app/page.tsx', 'app/page.tsx'],
  ];
  for (const [input, want] of cleanCases) {
    assert(cleanSourcePath(input) === want, `cleanSourcePath ${input}`, cleanSourcePath(input));
  }
  assert(cleanSourcePath(undefined) === '', "cleanSourcePath undefined => ''");

  // --- matchElementSource: normalize element source vs changed file list
  const changedFiles = ['server.mjs', 'fixture-expectations.json'];
  const abs = path.join(storefront, 'server.mjs');
  assert(
    matchElementSource(storefront, changedFiles, abs).changed === true,
    'matchElementSource absolute changed path',
  );
  assert(
    matchElementSource(storefront, changedFiles, abs).file === 'server.mjs',
    'matchElementSource returns matched file',
  );
  assert(
    matchElementSource(storefront, changedFiles, './server.mjs').changed === true,
    'matchElementSource relative ./ path',
  );
  assert(
    matchElementSource(storefront, changedFiles, 'webpack-internal:///./server.mjs:10:2')
      .changed === true,
    'matchElementSource webpack-internal + line/col',
  );
  assert(
    matchElementSource(storefront, changedFiles, 'app/page.tsx').changed === false,
    'matchElementSource unchanged file => false',
  );
  assert(
    matchElementSource(storefront, changedFiles, '').changed === false,
    'matchElementSource empty => false',
  );

  // --- buildChangeLinks: keep only elements whose source is a changed file
  const elements = [
    { id: 'a', sourcePath: abs, rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', sourcePath: 'app/page.tsx', rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'c', sourcePath: './server.mjs:3', rect: { x: 1, y: 1, width: 2, height: 2 } },
  ];
  const links = buildChangeLinks(storefront, changedFiles, elements);
  assert(
    eq(
      links.map((l) => l.id),
      ['a', 'c'],
    ),
    'buildChangeLinks filters to changed',
    JSON.stringify(links.map((l) => l.id)),
  );
  assert(
    links.every((l) => l.file === 'server.mjs'),
    'buildChangeLinks attaches matched file',
  );

  console.log(
    failures === 0
      ? '\nAll change-link tests passed.'
      : `\n${failures} change-link test(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
