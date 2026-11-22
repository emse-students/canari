#!/usr/bin/env bash
#
# Self-tests for `image-allowlist-retirement.sh`: an allowlist entry is dead when the package version
# it covers is in no scanned image (or none at its `paths:`), and ONLY then. The advisory feed
# dropping a CVE (the gosu entry `CVE-2026-97054` flapped three times) must not fail a build while
# the package still ships. An assertion that has never been seen to fail is a comment.
#
# Usage: .github/scripts/tests/image-allowlist-retirement.test.sh   (no arguments, no network)
set -uo pipefail

script=$(cd "$(dirname "$0")/.." && pwd)/image-allowlist-retirement.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# Three targets: gosu's Go stdlib v1.24.6 (ONE advisory reported), a deb with a release and an epoch,
# and ANOTHER image carrying a stdlib v1.25.0 at a different path.
scan='{"Results":[
 {"Target":"usr/local/bin/gosu","Packages":[{"Name":"stdlib","Version":"v1.24.6"}],
  "Vulnerabilities":[{"VulnerabilityID":"CVE-2026-97031","PkgName":"stdlib","InstalledVersion":"v1.24.6"}]},
 {"Target":"debian","Packages":[{"Name":"libpq5","Version":"17.12","Release":"0+deb13u1"},{"Name":"tzdata","Version":"2025b","Release":"1","Epoch":1}],
  "Vulnerabilities":[{"VulnerabilityID":"CVE-2026-5","PkgName":"tzdata","InstalledVersion":"1:2025b-1"}]},
 {"Target":"usr/local/bin/other","Packages":[{"Name":"stdlib","Version":"v1.25.0"},{"Name":"stdlib","Version":"v1.24.6"}]},
 {"Target":"Node.js","Packages":[{"Name":"undici","Version":"6.28.0","FilePath":"usr/local/lib/node_modules/npm/node_modules/undici/package.json"}]}]}'

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
  if [ "$fragment" = '-' ] && grep -q 'kept\.' <<<"$out"; then
    echo "FAIL $name: printed a kept-entry line it should not have"; failures=$((failures + 1)); return
  fi
  if grep -q '::notice\|::warning' <<<"$out"; then
    echo "FAIL $name: printed an annotation; a kept entry is a plain log line"; failures=$((failures + 1)); return
  fi
  echo "ok   $name"
}

expect cve-present-is-suppressed 0 - "$scan" $'CVE-2026-97031 stdlib v1.24.6 usr/local/bin/gosu\n'
expect cve-absent-package-present-is-kept 0 'CVE-2026-97054: not reported on stdlib v1.24.6 by Trivy DB vTEST (dropped, rescored below HIGH, or no fixed version any more)' "$scan" $'CVE-2026-97054 stdlib v1.24.6 usr/local/bin/gosu\n'
expect release-joined-package-is-found 0 'kept.' "$scan" $'CVE-2026-1 libpq5 17.12-0+deb13u1 -\n'
expect package-gone-is-dead 1 'CVE-2026-97054 on stdlib v1.25.0' "$scan" $'CVE-2026-97054 stdlib v1.25.0 usr/local/bin/gosu\n'
expect package-version-moved-is-dead 1 'no scanned image carries' "$scan" $'CVE-2026-97031 stdlib v1.24.5 -\n'
expect one-dead-among-live-fails 1 'CVE-2026-9 on gone-lib 1.0' "$scan" $'CVE-2026-97031 stdlib v1.24.6 -\nCVE-2026-9 gone-lib 1.0 -\n'
# THE POOLING HOLE: stdlib v1.24.6 also sits at usr/local/bin/other, so a purl-only entry stays alive
# by pooling, but an entry scoped to a path where it is NOT is dead, though the package exists elsewhere.
expect path-scoped-entry-alive-at-its-path 0 'kept.' "$scan" $'CVE-2026-97054 stdlib v1.24.6 usr/local/bin/other\n'
expect path-scoped-entry-dead-when-package-only-elsewhere 1 'CVE-2026-97054 on stdlib v1.24.6 usr/local/bin/gone' "$scan" $'CVE-2026-97054 stdlib v1.24.6 usr/local/bin/gone\n'
expect glob-path-matches-a-file-path 0 'kept.' "$scan" $'CVE-2026-109869 undici 6.28.0 usr/local/lib/node_modules/npm/**\n'
expect glob-path-misses-another-tree 1 'undici 6.28.0' "$scan" $'CVE-2026-109869 undici 6.28.0 opt/app/**\n'
# THE EPOCH: Trivy reports `1:2025b-1`, the purl (and so the entry) says `2025b-1`.
expect epoch-entry-matches-reported-without-epoch 0 - "$scan" $'CVE-2026-5 tzdata 2025b-1 -\n'
expect epoch-package-found-in-inventory 0 'kept.' "$scan" $'CVE-2026-6 tzdata 2025b-1 -\n'
expect epoch-version-found-with-epoch 0 'kept.' "$scan" $'CVE-2026-6 tzdata 1:2025b-1 -\n'
expect silent-scan 1 'printed nothing' '' $'CVE-2026-97031 stdlib v1.24.6 -\n'
expect no-inventory 1 'lists no package' '{"Results":[{"Vulnerabilities":[]}]}' $'CVE-2026-97031 stdlib v1.24.6 -\n'
expect nothing-covered 1 'names a package it covers' "$scan" ''

# The kept-entry line is printed ONCE per entry per run.
printf '%s' "$scan" >"$work/scan.json"
printf 'CVE-2026-97054 stdlib v1.24.6 -\nCVE-2026-97055 stdlib v1.24.6 -\n' >"$work/covers.txt"
lines=$(bash "$script" "$work/scan.json" "$work/covers.txt" "Trivy DB vTEST" 2>&1 | grep -c 'kept\.')
if [ "$lines" -eq 2 ]; then echo "ok   one-line-per-kept-entry"; else echo "FAIL one-line-per-kept-entry: $lines lines, want 2"; failures=$((failures + 1)); fi

[ "$failures" -eq 0 ] || { echo "$failures failure(s)"; exit 1; }
echo "all passed"
