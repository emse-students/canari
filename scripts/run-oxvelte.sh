#!/usr/bin/env bash
# Runs oxvelte with ~/.cargo/bin on PATH, installing the PINNED revision first.
#
# The install script runs on EVERY invocation, not only when the binary is missing: a machine that
# already has an oxvelte built from some other revision is exactly the case worth catching, and
# `command -v oxvelte` cannot see the difference. The check itself is a grep of cargo's
# .crates2.json, so the cost of being right here is a few milliseconds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$HOME/.cargo/bin:$PATH"

"$SCRIPT_DIR/install-oxvelte.sh"

exec oxvelte "$@"
