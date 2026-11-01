#!/usr/bin/env bash
#
# LAND WHAT A RELEASE WROTE ON ITS BRANCH ONTO `main`, AFTER THE FACT AND OFF THE CRITICAL PATH.
#
# Every release is bumped on the commit it was cut at and pushed to `release/vX.Y.Z`, never to
# `main` (pre-releases since 2026-10-30, stables since 2026-10-02 - docs/wiki/cicd.md, "A
# pre-release is pinned on its release branch"), because `main` keeps moving while a release runs
# and a push there was what refused or killed it. Two things `main` still owes the next reader are
# carried here instead, on `main`'s head, each by the ONE implementation that wrote it on the branch:
#
#   a PRE-RELEASE  its manifest version (`bump-app-version.sh <version>`), so `main` keeps naming
#                  the latest version released from it. FORWARD ONLY, by the store band: a landing
#                  re-run after a later release landed must not move `main` backwards.
#   a STABLE       its changelog: the fragments the SHIPPED commit carried are folded and deleted
#                  (a fragment merged after it documents a change this release did not contain).
#                  No manifest moves - `main` already names this version's latest pre-release, and
#                  the band of the stable over it buys nothing a reader needs.
#
# THE PUSH RACES every pull request that auto-merges, so it re-reads `main` and starts again, a
# few times; both landings are idempotent (the version already there, or a `[X.Y.Z]` heading
# present, means done), so a re-run after a partial failure is safe.
#
# args: <version, no v> <the commit the release was cut at>
# env:  REMOTE (default origin), BRANCH (default main), ATTEMPTS (default 5)
# Run from a git checkout whose remote carries credentials. Tested by
# `.github/scripts/tests/land-release.test.sh`.
set -euo pipefail

VERSION="${1:?version}"
SHIPPED="${2:?shipped commit}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
ATTEMPTS="${ATTEMPTS:-5}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUMP="$ROOT/scripts/bump-app-version.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/release-preconditions.sh
source "$ROOT/.github/scripts/lib/release-preconditions.sh"

KIND="$(release_kind "$VERSION")"
KIND="${KIND%% *}"
case "$KIND" in
  stable | prerelease) ;;
  *)
    echo "::error::$VERSION is not a version this project releases" >&2
    exit 1
    ;;
esac

FRAGMENTS="$(mktemp)"
trap 'rm -f "$FRAGMENTS"' EXIT
if [ "$KIND" = 'stable' ]; then
  # The fragments THE SHIPPED COMMIT carried, by basename.
  git ls-tree --name-only "$SHIPPED" changelog.d/ | sed 's|^changelog.d/||' | grep '\.md$' | grep -vx 'README.md' >"$FRAGMENTS" || true
  echo "landing the changelog of $VERSION: $(wc -l <"$FRAGMENTS") fragment(s) carried by ${SHIPPED:0:8}"
else
  echo "landing the version $VERSION (cut at ${SHIPPED:0:8}) on $BRANCH"
fi

# Writes the landing into the working tree, or prints why there is nothing to write.
land_once() {
  if [ "$KIND" = 'stable' ]; then
    CHANGELOG_FRAGMENTS_FROM="$FRAGMENTS" bash "$BUMP" "$VERSION"
    return 0
  fi
  local here have want
  here="$(jq -r '.version' frontend/package.json)"
  have="$(bash "$BUMP" --code "$here")"
  want="$(bash "$BUMP" --code "$VERSION")"
  if [ "$have" -ge "$want" ]; then
    # Not an error: `main` already names this version or a later one, and moving it back would
    # make it lie about what was released from it.
    echo "$BRANCH already names $here (band $have >= $want) - the version is not moved backwards"
    return 0
  fi
  bash "$BUMP" "$VERSION"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  git fetch "$REMOTE" "$BRANCH"
  git checkout -q -B land "$REMOTE/$BRANCH"
  land_once
  git add -u
  if git diff --cached --quiet; then
    echo "nothing to land - $BRANCH already carries what $VERSION wrote"
    exit 0
  fi
  if [ "$KIND" = 'stable' ]; then
    git commit -q -m "chore: land the changelog of $VERSION"
  else
    git commit -q -m "chore: bump version to $VERSION"
  fi
  if git push "$REMOTE" "HEAD:$BRANCH"; then
    echo "landed on $BRANCH at $(git rev-parse --short HEAD) (attempt $attempt)"
    exit 0
  fi
  echo "attempt $attempt: $BRANCH moved, starting again"
  sleep 2
done
echo "::error::could not land $VERSION on $BRANCH after $ATTEMPTS attempts - re-run the job" >&2
exit 1
