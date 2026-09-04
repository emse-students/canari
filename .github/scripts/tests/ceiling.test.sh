#!/usr/bin/env bash
#
# Self-tests for `lib/ceiling.sh`, the table that decides which Dependabot updates this repository
# has a gate for.
#
# IT EXISTS BECAUSE THE TABLE'S FAILURE MODE IS AN ABSENCE, AND AN ABSENCE IS INVISIBLE. On
# 2026-09-01 `postgres 15-alpine -> 18-alpine` auto-merged on a fully green suite and PostgreSQL 18
# refused to start on production's data directory; every backend service went down with `auth_db`,
# the only database. Nothing was broken - `postgres` had simply never been written into the table,
# and no test asked what the table covered.
#
# SO THE CENTRAL TEST BELOW DOES NOT HARDCODE A LIST OF NAMES. It reads the images out of
# `docker-compose.prod.yml` and requires an entry for every one that mounts a NAMED VOLUME. A gate
# that picks its subject by name does not cover the service nobody added to it - the same reasoning
# `app-module.boot-spec.ts` uses to walk every registered entity rather than a named few - so the
# next stateful service is covered on the day it is declared, by whoever declares it.
#
# Usage: .github/scripts/tests/ceiling.test.sh   (no arguments, no network, no dependencies)
set -uo pipefail

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/ceiling.sh
. "$(dirname "$0")/../lib/ceiling.sh"

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
compose="$repo_root/infrastructure/docker-compose.prod.yml"

failures=0

# THE SWEEP CHECKS OUT `.github/scripts` SPARSELY, so this file is one of two things that puts the
# compose file in the tree - the other being the `sparse-checkout` list in
# `ci.yml` (the `dependency-ceiling` job). Said here, by name, because the two have to
# move together and the
# failure otherwise reads as "the parse is broken" rather than "the file is not there".
if [ ! -f "$compose" ]; then
  echo "FAIL $compose is not in the tree, so the coverage assertion below cannot run."
  echo "     Add it to the sparse-checkout list in .github/workflows/ci.yml."
  exit 1
fi

# A dependency this repository must NOT merge unattended: the table has to name a gate for it.
expect_refused() {
  local name="$1" version="$2" why="$3" gate
  gate=$(gate_for_dependency "$name" "$version")
  if [ -n "$gate" ]; then
    echo "  ok   $name ${version:-(no version)} is refused"
  else
    echo "  FAIL $name ${version:-(no version)} is NOT refused, and it must be: $why"
    failures=$((failures + 1))
  fi
}

# A dependency the check suite IS evidence about. Asserted so the table cannot quietly widen into a
# blanket refusal, which would rebuild the queue nobody drains.
expect_allowed() {
  local name="$1" version="$2" gate
  gate=$(gate_for_dependency "$name" "$version")
  if [ -z "$gate" ]; then
    echo "  ok   $name ${version:-(no version)} is allowed"
  else
    echo "  FAIL $name ${version:-(no version)} is refused, but the suite is supposed to be evidence about it"
    echo "       gate: $gate"
    failures=$((failures + 1))
  fi
}

# -------------------------------------------------------------------------------------------------
# THE TEST THE OUTAGE ASKED FOR: every stateful image in production is in the table
# -------------------------------------------------------------------------------------------------
# The parse itself is `third_party_stateful_images` in `lib/ceiling.sh`, shared with
# `dev-gap.test.sh`; see the reasoning there.
echo "a MAJOR crossing is refused for every stateful third-party image production runs:"

seen=0
while read -r name vols; do
  [ -z "$name" ] && continue
  seen=$((seen + 1))

  # The crossing is CONSTRUCTED from what production runs rather than hardcoded, so this assertion
  # keeps meaning the same thing after the pins move - including after the postgres 18 migration,
  # when it will start demanding that 19 be refused without anybody editing this file.
  current=$(prod_image_major "$name")
  if [ -z "$current" ]; then
    echo "  FAIL could not read the major production pins for $name; the comparison cannot be made"
    failures=$((failures + 1))
    continue
  fi
  expect_refused "$name" "$((current + 1))" \
    "it mounts $vols named volume(s) in production, and every gate here starts from an empty one"
  # And the same-major direction, on the pin itself: a patch must keep flowing, or the digest pin
  # becomes the freeze `dependabot.yml` was written to prevent.
  expect_allowed "$name" "$current"
done <<< "$(third_party_stateful_images "$compose")"

# A parse that silently matched nothing would make the loop above vacuously green - the exact shape
# of failure this file exists to prevent. Production runs three stateful third-party images.
if [ "$seen" -lt 3 ]; then
  echo "  FAIL only $seen stateful image(s) were read out of $compose; the parse is broken, not the table"
  failures=$((failures + 1))
else
  echo "  ok   read $seen stateful image(s) from the compose file"
fi

# -------------------------------------------------------------------------------------------------
# The named entries, each asserted on the reason it is there
# -------------------------------------------------------------------------------------------------
echo "the datastore arm reads a version, and fails CLOSED when it cannot:"
# The incident itself, on the exact trailer Dependabot wrote (`postgres||18-alpine`): note the
# EMPTY update-type, which is why this arm cannot be a semver rule.
expect_refused postgres "18-alpine" "this is the 2026-09-01 outage, verbatim"
expect_allowed postgres "15.19-alpine"   # a patch within the running major
expect_allowed redis "8.10-alpine"       # #306 and #308: a minor, and the on-disk format is stable
expect_refused redis "9-alpine" "a redis major may rewrite the on-disk format of the message log"
expect_allowed "dxflrs/garage" "v2.4.0"  # garage is tagged with a leading v
expect_refused "dxflrs/garage" "v3.0.0" "garage holds the media store, and a major may move it"
# FAILING CLOSED IS THE POINT: a version nothing can parse must not read as "same major".
expect_refused postgres "" "an absent version cannot be compared, so it must not pass"
expect_refused postgres "latest" "an unparseable tag cannot be compared, so it must not pass"

echo "wire formats and unrunnable paths (the version is not consulted):"
expect_refused openmls "0.9.0" "a frame minted today must stay readable by the v0.14.14 clients in the fleet"
expect_refused openmls_traits "0.6.0" "the openmls release train moves as one piece"
expect_refused tls_codec "0.5.0" "it is the wire encoding itself"
expect_refused hpke-rs-crypto "0.3.0" "the hpke-rs* arm covers the whole family"
expect_refused webrtc-ice "0.20.3" "rung 15 CALL has no runner"
expect_refused turn "0.9.0" "the relay path is unmeasured"
expect_refused stripe "22.6.0" "crossing an API version is a decision about payments"
# A patch is refused for these too, deliberately - unlike a datastore, their failure mode does not
# depend on the version number at all, and asserting it keeps the two kinds of arm distinguishable.
expect_refused openmls "0.8.2" "a wire format is unmeasured at every version, not only across a major"

# -------------------------------------------------------------------------------------------------
# What must KEEP merging on its own. Each of these left the table when its gate was written, and a
# regression that put one back would stop a whole class of update without anybody deciding to.
# -------------------------------------------------------------------------------------------------
echo "what the suite is evidence about:"
expect_allowed "@nestjs/common" "12.0.1"   # released by `boot-nest-apps`, 2026-08-31
expect_allowed "@nestjs/core" "12.0.1"
expect_allowed typeorm "1.1.0"             # released by `app-module.boot-spec.ts`, 2026-08-31
expect_allowed argon2 "0.6.0"              # released by `cross_version_state.rs`, 2026-08-31
expect_allowed aes-gcm "0.11.0"            # released by `cross_version_push.rs`
# A STATELESS image is allowed even across a major: adminer mounts no volume, so there is no old
# data for a new version to refuse. This is the line that keeps the datastore arm about STATE rather
# than about being a container.
expect_allowed adminer "5.0.0"
expect_allowed svelte "6.0.0"
expect_allowed node "26-alpine"

# The caller strips the quotes Dependabot puts around a scoped name before consulting the table; if
# that ever regresses, `"@nestjs/common"` must not silently become an unmatched name. This asserts
# the table's contract: it is given a BARE name.
echo "the table is given a bare name:"
if [ -z "$(gate_for_dependency '"postgres"' '15-alpine')" ]; then
  echo "  ok   a quoted name does not match, so the caller's stripping is load-bearing and tested there"
else
  echo "  FAIL a quoted name matched; the table's contract is now ambiguous"
  failures=$((failures + 1))
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures assertion(s) failed."
  exit 1
fi
echo "all assertions passed."
