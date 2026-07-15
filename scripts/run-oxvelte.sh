#!/usr/bin/env bash
# Runs oxvelte with ~/.cargo/bin on PATH; installs via install-oxvelte.sh when missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v oxvelte >/dev/null 2>&1; then
  echo "oxvelte not found; installing (Rust >= 1.93 required)..."
  "$REPO_ROOT/scripts/install-oxvelte.sh"
fi

exec oxvelte "$@"
