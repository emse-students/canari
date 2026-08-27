#!/bin/sh
# Install oxvelte, the Svelte template linter, at the ONE revision this repository lints against.
# Called by scripts/run-oxvelte.sh, which is how anything here reaches oxvelte.
#
# POSIX sh, not bash: this script is the same file in five repositories, and one of them builds it
# inside `rust:*-alpine`, which ships no bash. Keeping one dialect means a fix travels; keeping two
# means the fix lands in whichever repository was being worked on that day.
#
# The revision is PINNED. `cargo install --git` with no `--rev` tracks the default branch, so two
# machines that ran the same command on different days hold different linters and disagree about the
# same file - a gate whose verdict is dated rather than explained. oxvelte publishes no tag past
# v0.1.2 and nothing on npm, so a commit sha is the only name this version has.
#
# No minimum-Rust check lives here. `rust-toolchain.toml` at the repository root already pins the
# toolchain rustup uses in this tree, and oxvelte declares no `rust-version` of its own, so a second
# number in this file would be a guess - and the guess that used to be here refused an install that
# then built fine on the toolchain it had just rejected. A build failure names the real requirement.
set -eu

OXVELTE_REPO="${OXVELTE_REPO:-https://github.com/tolgaouz/oxvelte.git}"
# oxvelte 0.2.0. Move it by editing this line, having read what changed - and move the cache key in
# .github/workflows/ci.yml with it, or CI restores the previous binary and lints with that.
OXVELTE_REV="${OXVELTE_REV:-7196779a744cee009abfc551e4c527bc98e26945}"

if [ -f "$HOME/.cargo/env" ]; then
	# shellcheck disable=SC1091
	. "$HOME/.cargo/env"
fi
PATH="$HOME/.cargo/bin:$PATH"
export PATH
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"

if ! command -v cargo >/dev/null 2>&1; then
	echo "Rust is required to build oxvelte. Install from https://rustup.rs/ then re-run."
	exit 1
fi

# cargo already records the source revision of everything it installed; no second stamp file is
# kept, so a manual `cargo install` is seen by this check exactly like an automatic one.
if command -v oxvelte >/dev/null 2>&1 &&
	grep -q "oxvelte .*#${OXVELTE_REV}" "$CARGO_HOME/.crates2.json" 2>/dev/null; then
	exit 0
fi

echo "Installing oxvelte $(echo "$OXVELTE_REV" | cut -c1-8) from ${OXVELTE_REPO}..."
cargo install --locked --force --git "$OXVELTE_REPO" --rev "$OXVELTE_REV"
