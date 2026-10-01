#!/usr/bin/env bash
# =================================================================================================
# WHICH ESTATE A BACKEND URL NAMES - `lib/backend-url.sh`, the one copy `build.yml`, `android.yml`
# and `ios.yml` all source. A store build cannot be re-pointed after it ships, so a wrong verdict
# here sends an alpha to real data or a stable to a box wiped every Monday.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/backend-url.sh
source "$HERE/../lib/backend-url.sh"

PASS=0
FAIL=0

# url <url> <expected verdict>
url() {
  local got
  got="$(classify_backend_url "$1")"
  if [ "$got" = "$2" ]; then
    PASS=$((PASS + 1)); printf '  ok    %s -> %s\n' "$1" "$2"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s -> expected %s, got %s\n' "$1" "$2" "$got"
  fi
}

url "https://canari.emse.fr" production
url "https://canari-emse.fr" production
url "https://canari.emse.fr/" production
url "https://dev.canari-emse.fr" dev
url "https://dev.canari-emse.fr/api" dev
url "https://example.com" unknown
url "https://canari.example.org" unknown
url "" unknown

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
