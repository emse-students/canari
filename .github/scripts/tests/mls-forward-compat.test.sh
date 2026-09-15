#!/usr/bin/env bash
#
# Self-tests for `../mls-forward-compat.sh` - the gate that lets a protocol crate be upgraded.
#
# THE THING THAT CAN GO WRONG HERE IS NOT A WRONG ANSWER, IT IS NO ANSWER. On 2026-09-15 the
# `openmls` / `tls_codec` / `hpke-rs*` / `libcrux*` family left `lib/ceiling.sh` because that gate
# was written; from that moment a Dependabot pull request bumping the MLS stack can merge
# unattended, and the ONLY thing standing between it and a member whose conversation stops
# decrypting is that the gate actually RUNS on that pull request.
#
# AND SUCH A PULL REQUEST TOUCHES NO SOURCE FILE AT ALL - it edits a lockfile. A path filter written
# to name `frontend/mls-core/**` would miss every single one of them and every run would be green
# for the reason that nothing was asked. That is the same shape as the `pull-request.yml` filter
# that named a renamed file and matched nothing for months, and as `postgres` missing from the
# ceiling table: an absence, invisible. So the central assertion below feeds the filter the file
# list a real Dependabot bump produces and requires it to fire.
#
# The gate ITSELF is not run here - it builds two copies of a Rust crate and needs the repository's
# tags. It runs as its own job in `ci.yml`, and this file asserts that it does.
#
# Usage: .github/scripts/tests/mls-forward-compat.test.sh   (no arguments, no network, no cargo)
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
gate="$repo_root/.github/scripts/mls-forward-compat.sh"
ci="$repo_root/.github/workflows/ci.yml"
params="$repo_root/frontend/mls-core/tests/cross_version/params.rs"
ceiling="$repo_root/.github/scripts/lib/ceiling.sh"

failures=0

ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; failures=$((failures + 1)); }

# -------------------------------------------------------------------------------------------------
# The gate exists, and CI binds it
# -------------------------------------------------------------------------------------------------
echo "the gate is a job that can fail the build:"

# EXISTS, not executable. Every script in this directory is invoked as `bash <path>` and most are
# recorded 100644 - `executable-bit.test.mjs` demands the bit only of the ones called as `./x`, and
# requiring it here failed CI on a checkout that had simply honoured the tree's own convention.
if [ -f "$gate" ]; then
  ok "the gate script is in the tree"
else
  bad "missing: $gate"
fi

if grep -q 'bash .github/scripts/mls-forward-compat.sh' "$ci"; then
  ok "ci.yml runs it"
else
  bad "ci.yml does not run the gate at all"
fi

# `ci-passed` is the ONE check the branch ruleset requires, so a job it does not need cannot block
# anything - it would go red beside a green merge.
if sed -n '/^  ci-passed:/,/^  [a-z]/p' "$ci" | grep -q 'mls-forward-compat'; then
  ok "ci-passed needs it, so a failure blocks the merge"
else
  bad "ci-passed does not need mls-forward-compat - the gate cannot block anything"
fi

# -------------------------------------------------------------------------------------------------
# THE CENTRAL ONE: does the filter fire for the pull request this gate exists to judge?
# -------------------------------------------------------------------------------------------------
echo "the change filter fires on what a protocol bump actually touches:"

# The patterns, read out of `ci.yml` rather than restated - a copy here could pass while the
# workflow's own filter said something else, which is the failure this whole file is about.
patterns=$(sed -n '/-- MLS cross-version compatibility --/,/mls_compat=true/p' "$ci" |
  grep -oE "has '[^']+'" | sed "s/^has '//; s/'$//")

if [ -z "$patterns" ]; then
  bad "could not read the mls_compat filter out of ci.yml - this test is measuring nothing"
  patterns='__none__'
fi

# Fires if ANY pattern matches ANY line, which is exactly what `has ... || has ...` means.
filter_fires() {
  local changed="$1" pattern
  while IFS= read -r pattern; do
    printf '%s\n' "$changed" | grep -qE "$pattern" && return 0
  done <<< "$patterns"
  return 1
}

expect_fires() {
  if filter_fires "$2"; then ok "$1"; else bad "$1 - the gate would NOT have run"; fi
}

expect_quiet() {
  if filter_fires "$2"; then bad "$1 - the gate runs for a change it cannot be about"; else ok "$1"; fi
}

# THE DEPENDABOT SHAPE, and the reason this file exists. `cargo` updates for this repository edit a
# lockfile and nothing else; `mls-core` commits no lock on purpose, so the bump lands in the locks
# of the two crates that SHIP.
expect_fires "a lockfile-only openmls bump (mls-wasm)" "frontend/mls-wasm/Cargo.lock"
expect_fires "a lockfile-only openmls bump (src-tauri)" "frontend/src-tauri/Cargo.lock"
expect_fires "a bump that also moves the manifest" "frontend/mls-core/Cargo.toml"
expect_fires "a change to the code that frames a message" "frontend/mls-core/src/messaging.rs"
expect_fires "a change to the driver both sides are built from" "frontend/mls-cross-version/src/main.rs"
expect_fires "a change to the gate itself" ".github/scripts/mls-forward-compat.sh"
expect_quiet "a documentation change" "docs/wiki/backlog.md"

# -------------------------------------------------------------------------------------------------
# The two halves of the cross-version story still agree
# -------------------------------------------------------------------------------------------------
echo "the gate and the table it retired moved together:"

if grep -q 'FIXTURE_VERSION' "$gate"; then
  ok "the gate reads the old version from params.rs instead of naming one"
else
  bad "the gate hardcodes an old version - it can now disagree with the frozen fixtures"
fi

if sed -n 's/^pub const FIXTURE_VERSION: &str = "\(.*\)";$/\1/p' "$params" | grep -q .; then
  ok "params.rs declares a FIXTURE_VERSION for it to read"
else
  bad "params.rs no longer declares FIXTURE_VERSION, so the gate cannot pick a tag"
fi

# A refusal that came BACK without the gate leaving would be harmless; the gate leaving while the
# refusal stays gone is the dangerous direction, and it is what this pins.
if grep -qE '^\s+openmls \| openmls_\*' "$ceiling"; then
  bad "lib/ceiling.sh refuses the openmls family again while this gate still exists - decide which"
else
  ok "lib/ceiling.sh no longer refuses the family this gate released"
fi

echo
if [ "$failures" -ne 0 ]; then
  printf '%s assertion(s) failed.\n' "$failures"
  exit 1
fi
printf 'all assertions passed.\n'
