#!/usr/bin/env bash
#
# Self-tests for `image-allowlist-retirement.sh`: an allowlist entry is dead when the package version
# it covers is in no scanned image, and ONLY then. The advisory feed dropping a CVE (the gosu entry
# `CVE-2026-97054` flapped three times) must not fail a build while the package still ships.
# An assertion that has never been seen to fail is a comment.
#
# Usage: .github/scripts/tests/image-allowlist-retirement.test.sh   (no arguments, no network)
set -uo pipefail

script=$(cd "$(dirname "$0")/.." && pwd)/image-allowlist-retirement.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# One image: gosu's Go standard library v1.24.6 with ONE advisory reported on it, a deb with a release.
scan='{"Results":[{"Target":"usr/local/bin/gosu","Packages":[{"Name":"stdlib","Version":"v1.24.6"}],
  "Vulnerabilities":[{"VulnerabilityID":"CVE-2026-97031","PkgName":"stdlib","InstalledVersion":"v1.24.6"}]},
 {"Target":"debian","Packages":[{"Name":"libpq5","Version":"17.12","Release":"0+deb13u1"}]}]}'

# expect <name> <want exit> <want stdout fragment or -> <scan json> <covers lines>
expect() {
  local name="$1" want="$2" fragment="$3" json="$4" covers="$5" out got
  printf '%s' "$json" >"$work/scan.json"
  printf '%s' "$covers" >"$work/covers.txt"
  out=$(bash "$script" "$work/scan.json" "$work/covers.txt" "Trivy DB vTEST" 2>&1)
  got=$?
  if [ "$got" -ne "$want" ]; then echo "FAIL $name: exit $got, want $want"; failures=$((failures + 1)); return; fi
  if [ "$fragment" != '-' ] && ! grep -qF -- "$fragment" <<<"$out"; then
    echo "FAIL $name: output lacks '$fragment'"; failures=$((failures + 1)); return
  fi
  if [ "$fragment" = '-' ] && grep -q '::notice' <<<"$out"; then
    echo "FAIL $name: printed a notice it should not have"; failures=$((failures + 1)); return
  fi
  echo "ok   $name"
}

expect cve-present-is-suppressed 0 - "$scan" $'CVE-2026-97031 stdlib v1.24.6\n'
expect cve-absent-package-present-is-a-notice 0 'CVE-2026-97054 is not reported on stdlib v1.24.6 by Trivy DB vTEST' "$scan" $'CVE-2026-97054 stdlib v1.24.6\n'
expect release-joined-package-is-found 0 '::notice' "$scan" $'CVE-2026-1 libpq5 17.12-0+deb13u1\n'
expect package-gone-is-dead 1 'CVE-2026-97054 on stdlib v1.25.0' "$scan" $'CVE-2026-97054 stdlib v1.25.0\n'
expect package-version-moved-is-dead 1 'no scanned image carries' "$scan" $'CVE-2026-97031 stdlib v1.24.5\n'
expect one-dead-among-live-fails 1 'CVE-2026-9 on gone-lib 1.0' "$scan" $'CVE-2026-97031 stdlib v1.24.6\nCVE-2026-9 gone-lib 1.0\n'
expect silent-scan 1 'printed nothing' '' $'CVE-2026-97031 stdlib v1.24.6\n'
expect no-inventory 1 'lists no package' '{"Results":[{"Vulnerabilities":[]}]}' $'CVE-2026-97031 stdlib v1.24.6\n'
expect nothing-covered 1 'names a package it covers' "$scan" ''

[ "$failures" -eq 0 ] || { echo "$failures failure(s)"; exit 1; }
echo "all passed"
