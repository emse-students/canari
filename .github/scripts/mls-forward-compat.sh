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
# AND ONE STATE CROSSES (2026-11-25), in its own conversation with the build a rollback lands on:
# today writes a state holding fields that build may predate, that build loads it, reads a frame and
# saves it, and today reopens it - each field carried exactly or dropped whole, the group intact.
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

# THE STATE LEG'S OLD SIDE IS ANOTHER VERSION: the one a ROLLBACK lands on (2026-11-25). A state blob
# is read by the device that wrote it - unless the build is rolled back, and the rule for a broken
# production is a rollback to the last good release, i.e. the newest stable. That is the build that
# would open a state this commit wrote, so it is the one asked. Not FIXTURE_VERSION: measured that
# day, v0.14.14 cannot load today's state at all (`load_or_create` -> `OpenMls(SerializationError)`,
# the openmls storage moved since), a rollback cut the project crossed long ago, and a leg that is
# red for it would say nothing about the next field. Derived from the tags, never typed here.
# newest_stable - the newest stable version among the tags on stdin: `vX.Y.Z` with no hyphen (the
# hyphen IS a pre-release, `release_kind()`), ordered as versions, so v1.10.0 follows v1.9.3.
newest_stable() {
  grep -E '^v[0-9]+[.][0-9]+[.][0-9]+$' | sort -V | tail -1
}
rollback_tag=$(git -C "$repo_root" tag --list 'v[0-9]*' | newest_stable)
[ -n "$rollback_tag" ] || fail "no stable tag (vX.Y.Z) is in this checkout - fetch tags before running this gate"
printf 'state side: %s (the newest stable: the release a rollback lands on)\n' "$rollback_tag"

work=$(mktemp -d)
old_tree="$work/old-checkout"
rollback_tree="$work/rollback-checkout"

# The worktrees are removed whatever happens, INCLUDING on a failure: a leftover one makes the next
# run fail on "already exists", which reads like a regression and is not one.
cleanup() {
  git -C "$repo_root" worktree remove --force "$old_tree" >/dev/null 2>&1
  git -C "$repo_root" worktree remove --force "$rollback_tree" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

# `cargo build` puts the binary under the manifest's own target dir; the extension differs by host.
locate() {
  for candidate in "$1/target/debug/mls-cross-version" "$1/target/debug/mls-cross-version.exe"; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

# build_old <tag> <tree> - checks <tag> out into <tree>, builds the driver there against THAT
# mls-core, and prints the binary's path.
build_old() {
  local tag="$1" tree="$2"
  git -C "$repo_root" worktree add --detach "$tree" "$tag" >/dev/null 2>&1 ||
    fail "could not check $tag out into a worktree"
  cp -r "$driver_src" "$tree/frontend/" || fail "could not copy the driver into the $tag checkout"
  cargo build --quiet --manifest-path "$tree/frontend/mls-cross-version/Cargo.toml" ||
    fail "the driver does not build against $tag's mls-core - the public API it drives has changed, so this gate can no longer speak to that version. Reconcile the driver with BOTH APIs rather than deleting the old call."
  locate "$tree/frontend/mls-cross-version" || fail "the $tag driver binary was not produced"
}

printf 'building the driver against today, %s and %s...\n' "$old_tag" "$rollback_tag"
# `--features today`: the commands writing and reading the fields an older tag may predate (the
# STATE leg below). An old build has neither, which is what lets one source compile against both.
cargo build --quiet --features today --manifest-path "$driver_src/Cargo.toml" ||
  fail "the driver does not build against today's mls-core"
new_bin=$(locate "$driver_src") || fail "today's driver binary was not produced"
old_bin=$(build_old "$old_tag" "$old_tree") || exit 1
rollback_bin=$(build_old "$rollback_tag" "$rollback_tree") || exit 1

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

# LEG 4, THE STATE: today writes, the ROLLBACK build reads and writes back, today reopens
# (2026-11-25). A rollback hands the newest stable a state this commit wrote, holding fields it may
# predate - `app_ledgers` (KILL-2), `admission` - all `#[serde(default)]`. "An older build ignores
# them on read and drops them on its next write" was a reading of serde, never a measurement; this
# leg measures it. Its own conversation, with its own states, so the frame legs above keep the rule
# that a side loads only what it wrote. Each failure names its half: the OLD LOAD and the OLD SAVE
# (the driver's own message says which: `load_or_create` / `process_incoming_message` /
# `save_state`), then the NEW RELOAD.
printf 'one state, written by today, rewritten by %s, reopened by today:\n' "$rollback_tag"
state_group="cross-version-state"
rb_state="$work/rollback.state"
carried_state="$work/carried.state"
step "$rollback_tag creates the group" "$rollback_bin" "$rb_state" alice create-group "$state_group"
step "today publishes a key package" "$new_bin" "$carried_state" bob gen-kp "$work/kp-state.bin"
step "$rollback_tag admits it" "$rollback_bin" "$rb_state" alice add-member "$state_group" "$work/kp-state.bin" "$work/welcome-state.bin" "$work/tree-state.bin"
joined=$("$new_bin" "$carried_state" bob join "$work/welcome-state.bin" "$work/tree-state.bin") ||
  fail "today's code could not open a Welcome minted by $rollback_tag"
[ "$joined" = "$state_group" ] || fail "today's code joined '$joined', not '$state_group'"
state_epoch=$("$rollback_bin" "$rb_state" alice epoch "$state_group")

step "today writes the app's ledgers and an admission policy into its state" "$new_bin" "$carried_state" bob seed-new-fields "$state_group"
seeded=$("$new_bin" "$carried_state" bob new-fields "$state_group") || fail "today could not reopen the state it just seeded"
seeded_ledgers=$(sed -n 1p <<<"$seeded")
case "$seeded" in
*'"ledger-format"="1"'*open) ;;
*) fail "today's own state does not carry what it seeded, so the leg would prove nothing: $seeded" ;;
esac

state_text="a frame minted by $rollback_tag, read by $rollback_tag inside a state today wrote"
step "$rollback_tag mints a frame for that state" "$rollback_bin" "$rb_state" alice send "$state_group" "$state_text" "$work/state-leg.bin"
step "OLD LOAD + OLD SAVE: $rollback_tag opens today's state, reads the frame and writes the state back" "$rollback_bin" "$carried_state" bob read "$state_group" "$work/state-leg.bin" "$state_text"

# NEW RELOAD. What the old write must have left, decided from a FACT - whether the rollback tag's
# `PersistedState` declares the field - never from a list typed here: a field it declares comes back
# EXACTLY as seeded (carried, not rewritten); a field it predates comes back EMPTY (dropped, not
# corrupted), which for the ledgers is the case the app reads as "migrate" (no `ledger-format`:
# stateLedgerMigration.ts re-stages, the documented over-burn, mls-desync-prevention.md KILL-2).
# Anything else - a partial map, a changed value - is a corruption, and red.
rollback_state_rs=$(git -C "$repo_root" show "$rollback_tag:frontend/mls-core/src/state.rs") ||
  fail "could not read $rollback_tag's state.rs to know which fields it declares"
want_ledgers='{}'
grep -qE '^[[:space:]]*pub app_ledgers:' <<<"$rollback_state_rs" && want_ledgers="$seeded_ledgers"
want_policy=none
grep -qE '^[[:space:]]*pub admission:' <<<"$rollback_state_rs" && want_policy=open
reloaded=$("$new_bin" "$carried_state" bob new-fields "$state_group") ||
  fail "NEW RELOAD: today's code could not reopen the state $rollback_tag wrote back"
got_ledgers=$(sed -n 1p <<<"$reloaded")
got_policy=$(sed -n 2p <<<"$reloaded")
[ "$got_ledgers" = "$want_ledgers" ] ||
  fail "NEW RELOAD: after $rollback_tag's write the ledgers read $got_ledgers, expected $want_ledgers ($([ "$want_ledgers" = '{}' ] && echo "it predates the field: dropped" || echo "it declares the field: carried"))"
[ "$got_policy" = "$want_policy" ] ||
  fail "NEW RELOAD: after $rollback_tag's write the admission policy reads $got_policy, expected $want_policy"
printf '  the ledgers came back %s, the admission policy %s\n' \
  "$([ "$want_ledgers" = '{}' ] && echo 'dropped (the rollback predates them)' || echo 'carried unchanged')" "$got_policy"
reloaded_epoch=$("$new_bin" "$carried_state" bob epoch "$state_group") ||
  fail "NEW RELOAD: today's code reads no epoch for the group in the state $rollback_tag wrote"
[ "$reloaded_epoch" = "$state_epoch" ] ||
  fail "NEW RELOAD: the group stands at epoch $reloaded_epoch in the state $rollback_tag wrote, not $state_epoch"
after_send="a frame minted by today from the state $rollback_tag wrote, read by $rollback_tag"
step "today sends from that state" "$new_bin" "$carried_state" bob send "$state_group" "$after_send" "$work/after-send.bin"
step "$rollback_tag reads it" "$rollback_bin" "$rb_state" alice read "$state_group" "$work/after-send.bin" "$after_send"
after_read="a frame minted by $rollback_tag, read by today from the state $rollback_tag wrote"
step "$rollback_tag mints one more" "$rollback_bin" "$rb_state" alice send "$state_group" "$after_read" "$work/after-read.bin"
step "today reads it from that state" "$new_bin" "$carried_state" bob read "$state_group" "$work/after-read.bin" "$after_read"

printf '\nPASS - today and %s hold a conversation in both directions, and a state today wrote survives %s\n' "$old_tag" "$rollback_tag"
