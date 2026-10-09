#!/usr/bin/env bash
#
# DOES EVERY TRACKED `.swift` FILE PARSE? - the one guard the iOS tree has on a machine with no Mac.
#
# THE GAP IT CLOSES. 25 Swift files ship in the iPhone app (the notification extension, six vendored
# plugins' `ios/` trees, five `Package.swift` manifests), and until this script NOTHING in a pull
# request read any of them: `bun run check`, `cargo clippy` and every other gate here see JavaScript
# and Rust. The only compile was `ios.yml`, which runs on a macOS runner after a release is cut, so a
# missing brace or a `guard` with no `else` was found by an App Store build, minutes into a release.
# Measured 2026-10-09: the two Swift "test targets" under the vendored plugins are the Xcode template
# (`testExample` builds a plugin and asserts nothing, against a package that needs a Tauri tree only
# a Mac has), and nothing runs them - so there is no suite to run, and writing one is the macOS-runner
# work the backlog already names.
#
# WHAT THIS COVERS, SAID PLAINLY. `swiftc -parse` is Swift's OWN grammar, with no SDK: it needs no
# `import UIKit` to resolve, so it runs on the Linux runner that `test-ci-scripts` already uses (the
# image ships Swift). It finds syntax errors. It does NOT find a type error, a missing symbol, an
# availability mistake or a `guard` body that falls through - those are semantic and stay with the
# `ios.yml` dispatch, which is why that workflow's header still calls itself the only compile.
#
# THE FILE SET IS DERIVED, NEVER LISTED: `git ls-files '*.swift'`, so the next plugin is covered by
# whoever adds it. An EMPTY set is a failure - a broken derivation reads exactly like a tree with no
# Swift in it.
#
# A MISSING `swiftc` IS A FAILURE ON CI AND A SKIPPED CHECK ON A WORKSTATION, said out loud. `CI` is
# set by GitHub; a Windows workstation has no Swift, and refusing to run `make test-ci-scripts` there
# for want of a Mac would make the whole recipe unusable. An unrun check on CI is not a clean one.
#
# Usage: .github/scripts/swift-syntax.sh
# Env:   SWIFTC (default swiftc), REPO_ROOT - overridden by the self-test only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$HERE/../.." && pwd)}"
SWIFTC="${SWIFTC:-swiftc}"

die() {
  echo "::error::$1"
  exit 1
}

files="$(git -C "$REPO_ROOT" ls-files '*.swift')" ||
  die "git could not list the tracked files, so no Swift file was checked."
[ -n "$files" ] ||
  die "no tracked .swift file was found. Either the iOS tree is gone (delete this guard) or the derivation is broken."
count="$(printf '%s\n' "$files" | grep -c .)"

if ! command -v "$SWIFTC" >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then
    die "\`$SWIFTC\` is not on PATH on CI, so $count Swift file(s) were NOT checked. The runner image used to ship Swift; if it stopped, install it (swift-actions/setup-swift) rather than skipping."
  fi
  echo "swift-syntax: \`$SWIFTC\` absent - $count Swift file(s) NOT checked here; CI will check them (a Windows workstation has no Swift)."
  exit 0
fi

failed=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ! out="$(cd "$REPO_ROOT" && "$SWIFTC" -parse "$f" 2>&1)"; then
    printf '%s\n' "$out" | head -20
    echo "::error file=$f::Swift does not parse"
    failed="$failed $f"
  fi
done <<<"$files"

if [ -n "$failed" ]; then
  die "swiftc -parse failed for:$failed"
fi
echo "swift-syntax: $count Swift file(s) parse."
