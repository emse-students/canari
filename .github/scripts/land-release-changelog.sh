#!/usr/bin/env bash
#
# LAND A STABLE'S CHANGELOG ON `main`.
#
# A stable is built on the latest pre-release's commit and pushed to `release/vX.Y.Z`, because
# `main` has usually moved past it. Its bump folded `changelog.d/*.md` into `CHANGELOG.md` and
# deleted the fragments - on that branch only. This script repeats exactly that fold on `main`'s
# head, for the fragments the SHIPPED commit carried and no others (a fragment merged after it
# documents a change this release did not contain), and never touches a manifest version: `main`'s
# is whatever its latest pre-release wrote and a landing must not move it backwards.
#
# THE PUSH RACES every pull request that auto-merges, so it re-reads `main` and starts again, a
# few times; the fold is idempotent (a `[X.Y.Z]` heading present means done), so a re-run after a
# partial failure is safe.
#
# args: <version, no v> <the commit the stable shipped from>
# env:  REMOTE (default origin), BRANCH (default main), ATTEMPTS (default 5)
# Run from a git checkout whose remote carries credentials. Tested by
# `.github/scripts/tests/land-release-changelog.test.sh`.
set -euo pipefail

VERSION="${1:?version}"
SHIPPED="${2:?shipped commit}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
ATTEMPTS="${ATTEMPTS:-5}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRAGMENTS="$(mktemp)"
trap 'rm -f "$FRAGMENTS"' EXIT

# The fragments THE SHIPPED COMMIT carried, by basename.
git ls-tree --name-only "$SHIPPED" changelog.d/ | sed 's|^changelog.d/||' | grep '\.md$' | grep -vx 'README.md' >"$FRAGMENTS" || true
echo "landing $VERSION: $(wc -l <"$FRAGMENTS") fragment(s) carried by ${SHIPPED:0:8}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  git fetch "$REMOTE" "$BRANCH"
  git checkout -q -B land "$REMOTE/$BRANCH"
  CHANGELOG_FRAGMENTS_FROM="$FRAGMENTS" bash "$ROOT/scripts/bump-app-version.sh" "$VERSION"
  git add -u
  if git diff --cached --quiet; then
    echo "nothing to land - $BRANCH already carries the $VERSION notes"
    exit 0
  fi
  git commit -q -m "chore: land the changelog of $VERSION"
  if git push "$REMOTE" "HEAD:$BRANCH"; then
    echo "landed on $BRANCH at $(git rev-parse --short HEAD) (attempt $attempt)"
    exit 0
  fi
  echo "attempt $attempt: $BRANCH moved, starting again"
  sleep 2
done
echo "::error::could not land the changelog of $VERSION after $ATTEMPTS attempts - re-run the job" >&2
exit 1
