#!/usr/bin/env bash
#
# Self-tests for `ios-extensions.sh` - the assertion that a built iOS app embeds exactly its two app
# extensions (notifications, share).
#
# Driven against FAKE bundles, because the cases that matter are the ones a green build never shows:
# an app that lost an extension, and one that gained an unexpected one.
#
# Usage: bash .github/scripts/tests/ios-extensions.test.sh   (no arguments, no network, no Xcode)
# `A && pass || fail` is the whole idiom of this file: `pass` cannot fail, so C never runs after a true A.
# shellcheck disable=SC2015
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../ios-extensions.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

make_app() { # make_app <name> <appex>...  -> a fake Canari.app holding those extensions
  local app="$work/$1/Canari.app"
  shift
  rm -rf "${work:?}/${app#"$work"/}"
  mkdir -p "$app"
  local appex
  for appex in "$@"; do
    mkdir -p "$app/PlugIns/$appex"
  done
  printf '%s' "$app"
}

run() { out="$(bash "$script" "$@" 2>&1)"; rc=$?; }

run "$(make_app both CanariNotifications.appex CanariShare.appex)"
[ "$rc" -eq 0 ] && pass 'both extensions: exit 0' || fail "both extensions: exit $rc: $out"

run "$(make_app noshare CanariNotifications.appex)"
[ "$rc" -eq 1 ] && pass 'the share extension missing: exit 1' || fail "missing share: exit $rc"
printf '%s' "$out" | grep -q 'CanariShare.appex' && pass 'the message names what must be there' || fail "not named: $out"

run "$(make_app extra CanariNotifications.appex CanariShare.appex Other.appex)"
[ "$rc" -eq 1 ] && pass 'an unexpected extension: exit 1' || fail "extra: exit $rc"

run "$(make_app none)"
[ "$rc" -eq 1 ] && pass 'no PlugIns at all: exit 1' || fail "none: exit $rc"

run "$work/does-not-exist"
[ "$rc" -eq 2 ] && pass 'not a directory: exit 2' || fail "not a dir: exit $rc"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
