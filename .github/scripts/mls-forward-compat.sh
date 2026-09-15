#!/usr/bin/env bash
#
# THE FORWARD HALF OF CROSS-VERSION COMPATIBILITY: does a frame minted by TODAY'S code still read on
# the binary the fleet is still running?
#
# `frontend/mls-core/tests/cross_version_state.rs` covers the backward half - today's code opening a
# state blob and a frame that v0.14.14 froze - and its own docblock names what it cannot reach:
# *"It says nothing about whether today's code writes something v0.14.14 could read, which is the
# other direction and matters when a fleet is mixed; that needs the old binary, not an old fixture."*
# `lib/ceiling.sh` refused every `openmls`, `tls_codec`, `hpke-rs` and `libcrux` update for exactly
# that absence. This script is the gate that closes it, so that refusal can leave.
#
# WHY IT CANNOT BE A FIXTURE, unlike every other cross-version gate here. `cross_version_push.rs`
# proves both directions for a raw AEAD by RE-SEALING the frozen plaintext under the frozen key and
# nonce and comparing bytes - equal bytes are equal in both directions. MLS encryption has no such
# handle: a frame carries a random reuse guard and padding, so today's code cannot reproduce a
# frozen ciphertext and there is nothing to compare. The old code has to actually RUN.
#
# HOW THE OLD BINARY IS OBTAINED, and why it is not a committed artefact. A checked-in `.exe` is
# unreviewable, platform-locked and impossible to re-derive; instead the old tag is checked out into
# a throwaway worktree and built from source, which takes ~17 s. `frontend/mls-cross-version` - one
# driver, depending on nothing but `mls-core` through a RELATIVE path - is copied into that worktree
# and built there, where `path = "../mls-core"` resolves to the old library. One source, two
# binaries. If the two APIs ever diverge, the old build fails to compile and names the call.
#
# THE TAG IS NOT WRITTEN HERE. It is read out of `tests/cross_version/params.rs`, which already
# names the version the frozen fixtures were written by, so the two halves of the cross-version
# story cannot come to disagree about which old version this repository claims to interoperate with.
#
# BOTH DIRECTIONS ARE EXERCISED, because the ceiling arm's own reasoning is that "a wire format is
# read by OTHER devices on OTHER versions". The old side creates the group and admits today's code
# through a Welcome (handshake, old -> new, which no fixture covers either), then today's code mints
# an application frame the old side must read (the forward half this exists for), and finally the
# old side mints one today's code must read. A failure names which leg broke.
#
# Usage: .github/scripts/mls-forward-compat.sh   (needs git and cargo; no network beyond
# the crates the two lockfiles already pin)
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
params="$repo_root/frontend/mls-core/tests/cross_version/params.rs"
driver_src="$repo_root/frontend/mls-cross-version"

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

[ -f "$params" ] || fail "missing $params, which is where the old tag is declared"
[ -d "$driver_src" ] || fail "missing $driver_src, the driver both sides are built from"

# ONE DECLARATION OF THE OLD VERSION, and it is the fixtures'. A second copy here would let this
# gate quietly test a different version from the one the frozen artefacts came from.
old_tag=$(sed -n 's/^pub const FIXTURE_VERSION: &str = "\(.*\)";$/\1/p' "$params")
[ -n "$old_tag" ] || fail "could not read FIXTURE_VERSION out of $params"
printf 'old side: %s (read from params.rs)\n' "$old_tag"

git -C "$repo_root" rev-parse -q --verify "refs/tags/$old_tag^{commit}" >/dev/null ||
  fail "tag $old_tag is not in this checkout - fetch tags (\`git fetch --tags --depth=1 origin $old_tag\`) before running this gate"

work=$(mktemp -d)
old_tree="$work/old-checkout"

# The worktree is removed whatever happens, INCLUDING on a failure: a leftover one makes the next
# run fail on "already exists", which reads like a regression and is not one.
cleanup() {
  git -C "$repo_root" worktree remove --force "$old_tree" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

git -C "$repo_root" worktree add --detach "$old_tree" "$old_tag" >/dev/null 2>&1 ||
  fail "could not check $old_tag out into a worktree"

cp -r "$driver_src" "$old_tree/frontend/" || fail "could not copy the driver into the old checkout"

printf 'building the driver against BOTH versions...\n'
cargo build --quiet --manifest-path "$driver_src/Cargo.toml" ||
  fail "the driver does not build against today's mls-core"
cargo build --quiet --manifest-path "$old_tree/frontend/mls-cross-version/Cargo.toml" ||
  fail "the driver does not build against $old_tag's mls-core - the public API it drives has changed, so this gate can no longer speak to the old fleet. Reconcile the driver with BOTH APIs rather than deleting the old call."

# `cargo build` puts the binary under the manifest's own target dir; the extension differs by host.
locate() {
  for candidate in "$1/target/debug/mls-cross-version" "$1/target/debug/mls-cross-version.exe"; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
new_bin=$(locate "$driver_src") || fail "today's driver binary was not produced"
old_bin=$(locate "$old_tree/frontend/mls-cross-version") || fail "the old driver binary was not produced"

group="cross-version-forward"
old_state="$work/old.state"
new_state="$work/new.state"

step() {
  printf '  %s\n' "$1"
  shift
  "$@" || fail "$*"
}

printf 'holding one conversation across the two versions:\n'

# LEG 1, old -> new, HANDSHAKE. The group is built by the old version, so every structure today's
# code reads from here on was minted by it - the ratchet tree included.
step "$old_tag creates the group" "$old_bin" "$old_state" alice create-group "$group"
step "today publishes a key package" "$new_bin" "$new_state" bob gen-kp "$work/kp.bin"
step "$old_tag admits it" "$old_bin" "$old_state" alice add-member "$group" "$work/kp.bin" "$work/welcome.bin" "$work/tree.bin"

joined=$("$new_bin" "$new_state" bob join "$work/welcome.bin" "$work/tree.bin") ||
  fail "today's code could not open a Welcome minted by $old_tag"
[ "$joined" = "$group" ] || fail "today's code joined '$joined', not '$group'"
printf '  today joined the group %s built\n' "$old_tag"

# The epochs must agree, or the legs below would be testing two different groups that happen to
# share a name. It is also the cheapest possible statement that the Welcome carried what it should.
old_epoch=$("$old_bin" "$old_state" alice epoch "$group")
new_epoch=$("$new_bin" "$new_state" bob epoch "$group")
[ "$old_epoch" = "$new_epoch" ] ||
  fail "the two versions disagree about the epoch after the join: $old_tag says $old_epoch, today says $new_epoch"
printf '  both versions stand at epoch %s\n' "$old_epoch"

# LEG 2, new -> old, AND THIS IS THE ONE THE CEILING ASKED FOR. The assertion is made inside the
# reading process, so no shell comparison stands between the plaintext and the verdict.
forward="a frame minted by today, read by $old_tag"
step "today mints an application frame" "$new_bin" "$new_state" bob send "$group" "$forward" "$work/forward.bin"
step "$old_tag reads it" "$old_bin" "$old_state" alice read "$group" "$work/forward.bin" "$forward"

# LEG 3, old -> new. The backward direction for a LIVE frame rather than a frozen one: the fixture
# covers one epoch of one group written once, and this covers the frame in the conversation the two
# versions are actually holding.
backward="a frame minted by $old_tag, read by today"
step "$old_tag mints one back" "$old_bin" "$old_state" alice send "$group" "$backward" "$work/backward.bin"
step "today reads it" "$new_bin" "$new_state" bob read "$group" "$work/backward.bin" "$backward"

printf '\nPASS - today and %s hold a conversation in both directions\n' "$old_tag"
