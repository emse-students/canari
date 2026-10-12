#!/usr/bin/env bash
#
# Self-tests for `swift-syntax.sh` - the parse guard over every tracked `.swift` file.
#
# WHAT THEY PIN, and it is not "does swiftc get called". The failures worth a test look like health:
#
#   - an EMPTY file set must FAIL, because a broken `git ls-files` reads exactly like a tree with no
#     Swift in it;
#   - one broken file must not hide a second: every file is parsed and every failure named;
#   - a missing `swiftc` must FAIL on CI (an unrun check is not a clean one) and be said out loud, not
#     silent, on a workstation that has no Swift;
#   - and where a REAL `swiftc` exists (the CI runner) the instrument is shown able to fail: a good
#     snippet parses and a snippet with a `guard` and no `else` does not. A guard that has never been
#     seen to fail proves nothing.
#
# The fake `swiftc` fails any file containing the word BROKEN; a fake tree and a real git make the
# derivation honest.
#
# Usage: .github/scripts/tests/swift-syntax.test.sh   (no arguments, no network)
# `A && pass || fail` is the whole idiom of this file: `pass` cannot fail, so C never runs after a true A.
# shellcheck disable=SC2015
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../swift-syntax.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

cat >"$work/fakeswiftc" <<'SH'
#!/usr/bin/env bash
# usage: fakeswiftc -parse FILE
if grep -q BROKEN "$2"; then echo "$2:1:1: error: expected declaration" >&2; exit 1; fi
SH
chmod +x "$work/fakeswiftc"

make_tree() { # make_tree <dir> <file:content>...
  local dir="$1"
  shift
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config core.autocrlf false
  local spec f c
  for spec in "$@"; do
    f="${spec%%:*}"
    c="${spec#*:}"
    mkdir -p "$dir/$(dirname "$f")"
    printf '%s\n' "$c" >"$dir/$f"
  done
  git -C "$dir" add -A
  git -C "$dir" -c user.name=t -c user.email=t@example.com commit -q -m t --allow-empty
}

run() { # run <tree> [ENV=VAL...]  -> sets out, rc
  local tree="$1"
  shift
  out="$(env -u CI "$@" REPO_ROOT="$tree" SWIFTC="${SWIFTC_UNDER_TEST:-$work/fakeswiftc}" bash "$script" 2>&1)"
  rc=$?
}

printf '\nevery tracked file is parsed, and the set is derived\n'
# =================================================================================================
make_tree "$work/t1" 'a/One.swift:import Foundation' 'b/Two.swift:let x = 1' 'notes.txt:BROKEN'
run "$work/t1"
[ "$rc" -eq 0 ] && pass 'two good files and a BROKEN non-swift file: exit 0' || fail "exit $rc: $out"
printf '%s' "$out" | grep -q '2 Swift file(s) parse' && pass 'it says how many it parsed (2, the .txt is not Swift)' || fail "count not stated: $out"

make_tree "$work/t2" 'a/One.swift:BROKEN' 'b/Two.swift:ALSO BROKEN' 'c/Three.swift:let ok = 1'
run "$work/t2"
[ "$rc" -eq 1 ] && pass 'broken files: exit 1' || fail "exit $rc"
printf '%s' "$out" | grep -q 'a/One.swift' && printf '%s' "$out" | grep -q 'b/Two.swift' &&
  pass 'BOTH broken files are named - one does not hide the other' || fail "not both named: $out"
printf '%s' "$out" | grep -q 'c/Three.swift' && fail 'the good file was reported' || pass 'the good file is not blamed'

printf '\nan empty set is a failure, not a clean tree\n'
# =================================================================================================
make_tree "$work/t3" 'readme.md:hello'
run "$work/t3"
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'no tracked .swift file' &&
  pass 'no Swift file: exit 1 and it says the derivation may be broken' || fail "exit $rc: $out"

printf '\na missing swiftc is loud on a workstation and fatal on CI\n'
# =================================================================================================
SWIFTC_UNDER_TEST="$work/does-not-exist" run "$work/t1"
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'NOT checked here' &&
  pass 'workstation: exit 0, and it says the files were NOT checked' || fail "exit $rc: $out"
SWIFTC_UNDER_TEST="$work/does-not-exist" run "$work/t1" CI=true
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'were NOT checked' &&
  pass 'CI: exit 1 - an unrun check is not a clean one' || fail "exit $rc: $out"

printf '\nwhere a real swiftc exists, the instrument is shown able to fail\n'
# =================================================================================================
if command -v swiftc >/dev/null 2>&1; then
  mkdir -p "$work/real"
  printf 'import Foundation\nfunc f(_ x: Int?) -> Int {\n  guard let y = x else { return 0 }\n  return y\n}\n' >"$work/real/good.swift"
  printf 'func f(_ x: Int?) -> Int {\n  guard let y = x { return 0 }\n  return y\n}\n' >"$work/real/bad.swift"
  swiftc -parse "$work/real/good.swift" >/dev/null 2>&1 && pass 'real swiftc: a valid function parses' || fail 'real swiftc rejected a valid function'
  swiftc -parse "$work/real/bad.swift" >/dev/null 2>&1 && fail 'real swiftc ACCEPTED a guard with no else' || pass 'real swiftc: a guard with no else does NOT parse'
  make_tree "$work/t4" 'ok/Good.swift:import Foundation
let answer = 42'
  SWIFTC_UNDER_TEST=swiftc run "$work/t4"
  [ "$rc" -eq 0 ] && pass 'the script passes a real good file through the real swiftc' || fail "exit $rc: $out"
  make_tree "$work/t5" 'bad/Bad.swift:guard let y = 1 { }'
  SWIFTC_UNDER_TEST=swiftc run "$work/t5"
  [ "$rc" -eq 1 ] && pass 'and fails a real bad file through the real swiftc' || fail "exit $rc: $out"
else
  printf '  skip  no swiftc on this machine - CI is where the instrument is shown able to fail\n'
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
