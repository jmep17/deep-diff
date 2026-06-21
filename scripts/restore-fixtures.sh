#!/usr/bin/env bash
#
# Restore the nested mock-repository git fixtures from their committed bundles.
#
# mock-repositories/auth0-routes-fixture is its own git repository with branches
# (main, feature/auth0-preview-callbacks) that the visual-diff/sidecar code runs
# `git worktree`/checkout against. A nested .git can't be committed into the
# parent repo, so the fixture's full history is shipped as a git bundle and the
# live directory is gitignored. Run this once after cloning the parent repo.
#
# Idempotent: skips any fixture that already has a .git directory.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

restore_bundle() {
  local fixture_dir="$1"
  local bundle="$2"

  if [ -d "$fixture_dir/.git" ]; then
    echo "✓ already present: ${fixture_dir#"$repo_root"/}"
    return 0
  fi
  if [ -e "$fixture_dir" ]; then
    echo "✗ ${fixture_dir#"$repo_root"/} exists but is not a git repo — remove it and re-run" >&2
    return 1
  fi
  if [ ! -f "$bundle" ]; then
    echo "✗ bundle not found: ${bundle#"$repo_root"/}" >&2
    return 1
  fi

  echo "→ restoring ${fixture_dir#"$repo_root"/} from bundle"
  git clone --quiet "$bundle" "$fixture_dir"

  # Recreate every bundled head as a local branch (clone only makes the default
  # branch local), so branch lookups in worktree operations resolve.
  local ref branch
  while read -r _ ref; do
    case "$ref" in
      refs/heads/*)
        branch="${ref#refs/heads/}"
        git -C "$fixture_dir" show-ref --verify --quiet "refs/heads/$branch" \
          || git -C "$fixture_dir" branch --quiet --track "$branch" "origin/$branch"
        ;;
    esac
  done < <(git bundle list-heads "$bundle")

  git -C "$fixture_dir" checkout --quiet main
  echo "✓ restored with branches: $(git -C "$fixture_dir" branch --format='%(refname:short)' | paste -sd' ' -)"
}

restore_bundle \
  "$repo_root/mock-repositories/auth0-routes-fixture" \
  "$repo_root/mock-repositories/auth0-routes-fixture.bundle"
