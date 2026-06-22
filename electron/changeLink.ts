// Code-change -> on-page element linking (core).
//
// This module holds the deterministic, browser-free half of the feature: given
// two git refs, which files changed, and given a raw source string read off a
// rendered DOM element (React fiber `_debugSource.fileName`, a `data-dds-source`
// attribute, etc.), does that element originate from a changed file?
//
// The runtime half — walking the sidecar webview's DOM to collect element
// sources and drawing highlight overlays — lives in the renderer and is
// verified live; everything here is unit-tested (scripts/test-change-link.mjs).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeRelativePath } from './routeDetection.js';

const execFileAsync = promisify(execFile);

// Matches the working-tree sentinel used by sidecar.ts / visualDiff.ts: a ref of
// this value means "the current working tree" rather than a committed ref.
const workingTreeRef = '__working_tree__';

export interface ProbedElement {
  /** Stable id assigned by the collector (e.g. an index or generated key). */
  id: string;
  /** Raw source string read off the element (fiber fileName or data attr). */
  sourcePath: string;
  /** Optional bounding rect for highlighting in the renderer. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Optional tag/label for display. */
  tag?: string;
}

export interface ChangeLink extends ProbedElement {
  /** Repo-relative path of the changed file this element maps to. */
  file: string;
}

/**
 * List the files that differ between two refs in a repo, as repo-relative,
 * forward-slash paths. A ref equal to `__working_tree__` is compared against the
 * current working tree (uncommitted changes) instead of a commit.
 */
export async function getChangedFiles(
  repoPath: string,
  baseRef: string,
  targetRef: string,
): Promise<string[]> {
  const args = ['-C', repoPath, 'diff', '--name-only'];
  // `git diff --name-only A B` diffs two trees; `git diff --name-only A` diffs A
  // against the working tree. The set of changed names is order-independent, so
  // when either side is the working-tree sentinel we drop it and diff the other.
  if (baseRef === workingTreeRef && targetRef === workingTreeRef) {
    // Degenerate: nothing to compare.
    return [];
  } else if (targetRef === workingTreeRef) {
    args.push(baseRef);
  } else if (baseRef === workingTreeRef) {
    args.push(targetRef);
  } else {
    args.push(baseRef, targetRef);
  }

  const { stdout } = await execFileAsync('git', args);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Normalize a raw source string read off a DOM element down to a comparable
 * path: strip bundler/url wrappers (`webpack-internal:///`, `file://`,
 * `webpack://`), any `?query`/`#hash`, a trailing `:line` or `:line:col`, and a
 * leading `./`. Returns '' for empty/non-string input.
 */
export function cleanSourcePath(raw: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  s = s.replace(/^webpack-internal:\/\/\/?/, '');
  s = s.replace(/^webpack:\/\/\/?/, '');
  s = s.replace(/^file:\/\//, '');
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/:\d+(:\d+)?$/, '');
  s = s.replace(/^\.\//, '');
  return s;
}

/**
 * Does a raw element source map to one of the changed files? Returns the matched
 * repo-relative file when it does.
 */
export function matchElementSource(
  repoPath: string,
  changedFiles: string[],
  rawSource: unknown,
): { changed: boolean; file?: string } {
  const cleaned = cleanSourcePath(rawSource);
  if (!cleaned) return { changed: false };
  const elementRel = normalizeRelativePath(repoPath, cleaned);
  for (const changed of changedFiles) {
    const changedRel = normalizeRelativePath(repoPath, cleanSourcePath(changed) || changed);
    if (changedRel === elementRel) {
      return { changed: true, file: changedRel };
    }
  }
  return { changed: false };
}

/**
 * Filter probed elements down to those originating from a changed file,
 * attaching the matched repo-relative file path to each.
 */
export function buildChangeLinks(
  repoPath: string,
  changedFiles: string[],
  elements: ProbedElement[],
): ChangeLink[] {
  const links: ChangeLink[] = [];
  for (const element of elements) {
    const match = matchElementSource(repoPath, changedFiles, element.sourcePath);
    if (match.changed && match.file) {
      links.push({ ...element, file: match.file });
    }
  }
  return links;
}
