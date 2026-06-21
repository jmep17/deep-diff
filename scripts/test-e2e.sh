#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=ensure-node.sh
source "$ROOT/scripts/ensure-node.sh"

E2E_PORT="${DEEP_DISH_E2E_PORT:-5174}"
E2E_URL="http://127.0.0.1:${E2E_PORT}"
CYPRESS_BROWSER="${CYPRESS_BROWSER:-electron}"
export DEEP_DISH_E2E_PORT="$E2E_PORT"
export CYPRESS_BROWSER
export CYPRESS_CACHE_FOLDER="$ROOT/.cache/cypress"

if ! "$ROOT/node_modules/.bin/cypress" verify >/dev/null 2>&1; then
  echo "Cypress binary missing; running pnpm run cy:install..."
  pnpm run cy:install
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

test_command=("$ROOT/node_modules/.bin/cypress" run --browser "$CYPRESS_BROWSER")
if [ "$#" -gt 0 ]; then
  test_command+=("$@")
fi
printf -v test_command_string "%q " "${test_command[@]}"

server_command=("$ROOT/node_modules/.bin/vite" --host 127.0.0.1 --port "$E2E_PORT" --strictPort)
printf -v server_command_string "%q " "${server_command[@]}"

exec "$ROOT/node_modules/.bin/start-server-and-test" \
  "$server_command_string" \
  "$E2E_URL" \
  "$test_command_string"
