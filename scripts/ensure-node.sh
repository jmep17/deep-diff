#!/usr/bin/env bash
# Source or run: puts fnm's Node on PATH for this shell session.
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
  if [ -f ".node-version" ]; then
    fnm use --install-if-missing >/dev/null 2>&1 || fnm use >/dev/null 2>&1 || true
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is not on PATH." >&2
  echo "Run: eval \"\$(fnm env)\" && fnm use" >&2
  echo "Or:  source scripts/ensure-node.sh" >&2
  return 1 2>/dev/null || exit 1
fi
