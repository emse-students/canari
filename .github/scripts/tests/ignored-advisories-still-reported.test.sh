#!/usr/bin/env bash
#
# Self-tests for `ignored-advisories-still-reported.sh`: it must pass while every ignored advisory is
# still reported and FAIL when one stops being, when the audit is silent, and when nothing is named.
# An assertion that has never been seen to fail is a comment.
#
# Usage: .github/scripts/tests/ignored-advisories-still-reported.test.sh   (no arguments, no network)
set -uo pipefail

script=$(cd "$(dirname "$0")/.." && pwd)/ignored-advisories-still-reported.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# expect <name> <want exit> <audit text> <ids...>
expect() {
  local name="$1" want="$2" text="$3"
  shift 3
  printf '%s' "$text" >"$work/$name"
  bash "$script" "$work/$name" "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $name"; else echo "FAIL $name: exit $got, want $want"; failures=$((failures + 1)); fi
}

both=$'minio  >stream-json\n  moderate: https://github.com/advisories/GHSA-aaaa-1111\n  moderate: https://github.com/advisories/GHSA-bbbb-2222\n'
expect all-reported 0 "$both" GHSA-aaaa-1111 GHSA-bbbb-2222
expect one-retired 1 $'moderate: https://github.com/advisories/GHSA-aaaa-1111\n' GHSA-aaaa-1111 GHSA-bbbb-2222
expect silent-audit 1 '' GHSA-aaaa-1111
expect nothing-named 1 "$both"
bash "$script" "$work/does-not-exist" GHSA-aaaa-1111 >/dev/null 2>&1
if [ $? -eq 1 ]; then echo "ok   output-missing"; else echo "FAIL output-missing"; failures=$((failures + 1)); fi

[ "$failures" -eq 0 ] || { echo "$failures failure(s)"; exit 1; }
echo "all passed"
