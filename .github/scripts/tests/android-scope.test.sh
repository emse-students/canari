#!/usr/bin/env bash
#
# Does the Android unit-test scope fire on what the suite actually compiles and reads?
#
# `android-tests` compiles the app's pure Kotlin AND each plugin's `pure/` directory, and its
# contract tests read `libs/contracts/` (build.gradle.kts). A change to any of them must run the
# suite; a plugin's platform Kotlin (outside `pure/`) is not compiled there and must not.
#
# The patterns are READ out of `ci-scopes.sh`, never restated: a copy here could pass while the
# filter itself said something else (the shape of `mls-forward-compat.test.sh`).
#
# Run by `make test-ci-scripts`.
# shellcheck disable=SC2015
set -uo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
PASS=0
FAIL=0
ok() {
  printf '  ok   %s\n' "$1"
  PASS=$((PASS + 1))
}
bad() {
  printf '  FAIL %s\n' "$1"
  FAIL=$((FAIL + 1))
}

patterns=$(sed -n '/-- Android unit tests --/,/android=true/p' "$repo_root/.github/scripts/ci-scopes.sh" |
  grep -oE "has '[^']+'" | sed "s/^has '//; s/'$//")
if [ -z "$patterns" ]; then
  bad "could not read the android filter out of ci-scopes.sh - this test is measuring nothing"
  patterns='__none__'
fi

# Fires if ANY pattern matches the path, which is exactly what `has ... || has ...` means.
fires() {
  local pattern
  while IFS= read -r pattern; do
    grep -qE "$pattern" <<<"$1" && return 0
  done <<<"$patterns"
  return 1
}

expect() { # expect <true|false> <path>
  local got=false
  fires "$2" && got=true
  [ "$got" = "$1" ] && ok "android=$1 for $2" || bad "android=$got for $2, expected $1"
}

echo "the android scope fires on what android-tests compiles and reads:"
expect true frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/push/Ladder.kt
expect true frontend/src-tauri/android-tests/src/test/kotlin/fr/emse/canari/RestoreOriginTest.kt
expect true frontend/src-tauri/plugins/x/android/src/main/java/pure/Thing.kt
expect true frontend/src-tauri/plugins/tauri-plugin-restore/android/src/main/java/pure/ApkKeyHash.kt
expect true libs/contracts/restore-apk-key-hash.cases.json
echo "and not on what it does not:"
expect false frontend/src-tauri/plugins/tauri-plugin-restore/android/src/main/java/RestorePlugin.kt
expect false frontend/src/lib/services/restoreCredential.ts

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
