#!/usr/bin/env bash
# Install oxvelte (Svelte template linter) when missing. Requires Rust >= 1.93.
set -euo pipefail

OXVELTE_REPO="${OXVELTE_REPO:-https://github.com/tolgaouz/oxvelte.git}"
MIN_RUST_VERSION="${MIN_RUST_VERSION:-1.93.0}"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v rustc >/dev/null 2>&1; then
  echo "Rust is required (>= ${MIN_RUST_VERSION}). Install from https://rustup.rs/ then re-run."
  exit 1
fi

current_rust="$(rustc --version | sed -E 's/rustc ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
if [ "$(printf '%s\n%s\n' "$MIN_RUST_VERSION" "$current_rust" | sort -V | head -n1)" != "$MIN_RUST_VERSION" ]; then
  echo "Rust ${MIN_RUST_VERSION}+ required for oxvelte (found ${current_rust}). Run: rustup update stable"
  exit 1
fi

if command -v oxvelte >/dev/null 2>&1; then
  echo "oxvelte already installed: $(oxvelte --version 2>/dev/null || echo ok)"
  exit 0
fi

echo "Installing oxvelte from ${OXVELTE_REPO}..."
cargo install --locked --git "$OXVELTE_REPO"
