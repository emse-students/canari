#!/usr/bin/env bash
#
# Self-test for `image-scan-targets.sh`: the list the image scan reads must be the images the estates
# RUN. Its failure mode is an absence - an image nothing scans - so every assertion here is about
# something being IN the list, or a source that cannot be read failing rather than shrinking it.
#
# Usage: bash .github/scripts/tests/image-scan-targets.test.sh   (no network)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../image-scan-targets.sh"
repo_root="$(cd "$here/../../.." && pwd)"
failures=0
ok() { echo "  ok   $1"; }
ko() { echo "  FAIL $1"; failures=$((failures + 1)); }

list="$(bash "$script" "$repo_root")" || { echo "FAIL image-scan-targets.sh failed on this repository"; exit 1; }

echo "every third-party image a production or dev compose file runs is scanned:"
for f in infrastructure/docker-compose.prod.yml infrastructure/docker-compose.dev.yml; do
  while read -r ref; do
    [ -z "$ref" ] && continue
    if grep -qxF "$ref" <<< "$list"; then ok "$ref ($f)"; else ko "$ref, run by $f, is not scanned"; fi
  done < <(awk '$1 == "image:" && $2 !~ /\$\{/ { print $2 }' "$repo_root/$f")
done

echo "every Dockerfile's SHIPPED stage is scanned, and no builder stage is:"
for df in "$repo_root"/infrastructure/local/Dockerfile.*; do
  last="$(awk 'toupper($1) == "FROM" { ref = $2 } END { print ref }' "$df")"
  if grep -qxF "$last" <<< "$list"; then ok "$last (${df##*/})"; else ko "$last, the runtime base of ${df##*/}, is not scanned"; fi
done
if grep -q '^rust:' <<< "$list"; then ko "a rust builder image is scanned, and it never reaches an estate"; else ok "no rust builder image is in the list"; fi

echo "an interpolated reference is read as its default, and this repository's own images are left out:"
if grep -qE '^ghcr\.io/goauthentik/server:[0-9]' <<< "$list"; then ok "the identity provider's server image is resolved to its default tag"; else ko "the identity provider's server image is missing or unresolved"; fi
if grep -qF 'ghcr.io/emse-students/canari/' <<< "$list"; then ko "an image this repository builds is in the list"; else ok "no image this repository builds is in the list"; fi

echo "a source that cannot be read fails instead of shrinking the list:"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/infrastructure/local" "$work/infrastructure/authentik"
printf 'FROM alpine:3 AS b\nFROM debian:bookworm-slim\n' > "$work/infrastructure/local/Dockerfile.x"
printf 'services:\n  a:\n    image: redis:8\n' > "$work/infrastructure/docker-compose.prod.yml"
printf 'services:\n  a:\n    image: redis:8\n' > "$work/infrastructure/docker-compose.dev.yml"
# shellcheck disable=SC2016 # a compose file's own `${...}` is the fixture, written literally.
printf 'services:\n  a:\n    image: ${IMG:-postgres}:${TAG:-16-alpine}\n' > "$work/infrastructure/authentik/compose.yml"
got="$(bash "$script" "$work" 2>/dev/null | tr '\n' ' ')"
if [ "$got" = "debian:bookworm-slim postgres:16-alpine redis:8 " ]; then ok "a fixture reads as its shipped stage, its images and its defaults"; else ko "the fixture read as '$got'"; fi
# shellcheck disable=SC2016 # the same: a literal compose interpolation.
printf 'services:\n  a:\n    image: ${NO_DEFAULT}\n' > "$work/infrastructure/authentik/compose.yml"
if bash "$script" "$work" >/dev/null 2>&1; then ko "an image named by a variable with no default passed"; else ok "an image named by a variable with no default fails"; fi
rm "$work/infrastructure/docker-compose.dev.yml"
if bash "$script" "$work" >/dev/null 2>&1; then ko "a missing compose file passed"; else ok "a missing compose file fails"; fi

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "OK: the image scan reads every image the estates run."
