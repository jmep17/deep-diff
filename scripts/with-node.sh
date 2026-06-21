#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=ensure-node.sh
source "$ROOT/scripts/ensure-node.sh"

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/with-node.sh <command> [args...]" >&2
  echo "example: bash scripts/with-node.sh pnpm install" >&2
  exit 1
fi

exec "$@"
