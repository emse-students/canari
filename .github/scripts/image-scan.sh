#!/usr/bin/env bash
#
# THE CONTAINER IMAGE SCAN: every image an estate runs, against Trivy's vulnerability database.
#
# Nothing scanned an image until 2026-10-23. `bun audit` and `cargo audit` read lockfiles; the OS
# packages and the binaries an image carries (an Alpine `libssl`, the Go runtime inside `gosu`, the
# Python of the identity provider) were read by nothing, while those images are what production
# actually runs. The list comes from `image-scan-targets.sh`, derived from the files that run them.
#
# THE BAR: HIGH or CRITICAL, WITH A FIX PUBLISHED (`--ignore-unfixed`). An advisory nobody can act on
# yet is not a gate, it is a wall; one with a fix is a pull request somebody can open today.
#
# THE ALLOWLIST IS `.github/image-scan-allowlist.yaml`, Trivy's own ignore-file format, one entry per
# advisory with a `statement` saying why it is not reachable or not ours to fix. And it RETIRES ITSELF:
# every image is scanned a second time WITHOUT the allowlist, and an entry that scan no longer reports
# fails the run (`ignored-advisories-still-reported.sh`, the same check media-service's audit ignores
# use). An ignore that outlives its reason is a hole with a comment over it.
#
# Exit, the same three codes as `audit-dependencies.sh`:
#   0  every image was scanned and nothing outside the allowlist was found, and every entry is needed
#   1  a finding, an allowlist entry that nothing reports any more, or a `dockerfile:` target that
#      does not build
#   2  an image or the database could not be READ (registry or mirror outage) - no verdict. The
#      caller decides what that costs: `REGISTRY_OUTAGE_IS_FAILURE=true` turns it into a 1.
#
# Usage: image-scan.sh                    (`trivy` on PATH, and `docker` for a `dockerfile:` target;
#                                          `TRIVY_CACHE_DIR` honoured)
#        image-scan.sh --allowlist-ids    (the ids the retirement check reads; no network)
#        image-scan.sh --allowlist-purls  (the `id package version` triples it reads; no network)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
allowlist="$here/../image-scan-allowlist.yaml"
[ -f "$allowlist" ] || { echo "::error::$allowlist is missing"; exit 1; }

# The advisory ids the allowlist names, one per line. The retirement check below asks about exactly
# these, so `image-scan-allowlist.test.mjs` compares them with a real YAML parse of the file: an entry
# this reader missed would be an ignore nothing ever retires.
allowlist_ids() {
  grep -oE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*[\"']?(CVE|GHSA)-[A-Za-z0-9-]+" "$allowlist" |
    grep -oE '(CVE|GHSA)-[A-Za-z0-9-]+' | sort -u
}
# Every purl-scoped entry as `<id> <name> <version>`, one per line, the version percent-decoded.
# An id alone cannot retire such an entry: one advisory can be allowlisted on two packages (brotli,
# Alpine's `brotli-libs` and Debian's `libbrotli1`), and the id stays reported while either remains,
# so the half that moved would sit in the file for ever. The retirement check asks about each PAIR,
# and `image-scan-allowlist.test.mjs` compares these with a real YAML parse, as for the ids.
allowlist_purls() {
  awk '
    /^[[:space:]]*-[[:space:]]*id:/ { id = $0; sub(/^[^:]*:[[:space:]]*/, "", id); gsub(/["\047[:space:]]/, "", id) }
    /^[[:space:]]*-[[:space:]]*["\047]?pkg:/ { p = $0; sub(/^[[:space:]]*-[[:space:]]*/, "", p); gsub(/["\047[:space:]]/, "", p); print id, p }
  ' "$allowlist" |
    while read -r id purl; do
      nv="${purl%%\?*}"
      nv="${nv##*/}"
      version="${nv#*@}"
      printf '%s %s %b\n' "$id" "${nv%%@*}" "${version//%/\\x}"
    done | sort -u
}
if [ "${1:-}" = '--allowlist-ids' ]; then
  allowlist_ids
  exit 0
fi
if [ "${1:-}" = '--allowlist-purls' ]; then
  allowlist_purls
  exit 0
fi

command -v trivy >/dev/null || { echo "::error::trivy is not on PATH"; exit 1; }

targets="$(bash "$here/image-scan-targets.sh")" || exit 1
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

outage() {
  if [ "${REGISTRY_OUTAGE_IS_FAILURE:-false}" = 'true' ]; then
    echo "::error::$1 - and this caller treats an unscanned image as a failure. No verdict was reached about the image."
    exit 1
  fi
  echo "::warning title=Image scan::$1 - no verdict was reached, and a pull request is not stopped by an outage nobody here can fix."
  exit 2
}

echo "--- the vulnerability database"
if ! trivy image --quiet --download-db-only; then
  outage "the Trivy vulnerability database could not be downloaded, so NO image was scanned"
fi

common=(--quiet --skip-db-update --scanners vuln --severity 'HIGH,CRITICAL' --ignore-unfixed)
root="$(cd "$here/../.." && pwd)"
found=""
unread=""
broken=""
while IFS= read -r target; do
  echo "--- $target"
  # `dockerfile:<path>` is an image whose shipped stage upgrades its base's packages, so its base is
  # not what an estate runs (`image-scan-targets.sh`): it is BUILT here, from the same file and the
  # same context `build.yml` uses, and the local result is scanned. Every other target is a reference
  # Trivy reads from its registry. A build that fails is a FINDING (exit 1), never an outage: the file
  # is ours, and an image we cannot build is one the release cannot ship (review of #3442) - exit 2
  # stays for the registry and the database alone.
  # `</dev/null`: docker must not read this loop's list as its own stdin.
  case "$target" in
    dockerfile:*)
      path="${target#dockerfile:}"
      name="${path##*/Dockerfile.}"
      image="canari-image-scan/$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]'):local"
      if ! DOCKER_BUILDKIT=1 docker build --quiet --no-cache --file "$root/$path" --tag "$image" "$root" </dev/null >/dev/null; then
        echo "    $path could not be built"
        broken="$broken $target"
        continue
      fi
      src=(--image-src docker)
      ;;
    *)
      image="$target"
      src=(--image-src remote)
      ;;
  esac
  rc=0
  trivy image "${common[@]}" "${src[@]}" --ignorefile "$allowlist" --exit-code 3 --format table "$image" || rc=$?
  case "$rc" in
    0) echo "    clean, once the allowlist is applied" ;;
    3) found="$found $target" ;;
    *) unread="$unread $target"; continue ;;
  esac
  # The same image WITHOUT the allowlist, for the retirement check below.
  trivy image "${common[@]}" "${src[@]}" --exit-code 0 --format json --output "$work/raw-$(printf '%s' "$target" | tr -c 'A-Za-z0-9.-' '_').json" "$image" ||
    unread="$unread $target"
done <<< "$targets"

retired=0
ids="$(allowlist_ids || true)"
if [ -z "$ids" ]; then
  echo "    the allowlist is empty; nothing to retire."
elif [ -n "$unread" ] || [ -n "$broken" ]; then
  # An image that was not read cannot say an entry is unneeded: only an ANSWER retires one.
  echo "    some image was not read, so nothing is concluded about the allowlist."
else
  echo "--- every allowlisted advisory is still reported"
  cat "$work"/raw-*.json > "$work/all.json"
  # shellcheck disable=SC2086 # `$ids` is a deliberately word-split list of advisory ids.
  bash "$here/ignored-advisories-still-reported.sh" "$work/all.json" $ids || retired=1
  # And every purl-scoped entry on ITS package: the id check above cannot see one half of a shared id move.
  reported="$(jq -r '.Results[]?.Vulnerabilities[]? | "\(.VulnerabilityID) \(.PkgName) \(.InstalledVersion)"' "$work/all.json" | sort -u)"
  gone="$(allowlist_purls | grep -vxF -f <(printf '%s\n' "$reported") || true)"
  if [ -n "$gone" ]; then
    printf '%s\n' "$gone" | sed 's/^/    no longer reported: /'
    echo "::error::the scan no longer reports the advisory on the package a purl-scoped allowlist entry names (listed above as id, package, version) - the image moved, so delete that purl or its entry."
    retired=1
  else
    echo "    every purl-scoped entry is still reported on its package."
  fi
fi

if [ -n "$found" ]; then
  echo "::error::HIGH or CRITICAL vulnerabilities with a published fix, outside the allowlist, in:$found. Move the pin to a fixed image, or allowlist the advisory in .github/image-scan-allowlist.yaml with a statement saying why it does not reach us."
fi
if [ -n "$broken" ]; then
  echo "::error::a Dockerfile this repository owns could not be built for the scan:$broken. That is a finding about our file, not an outage: fix the build."
fi
if [ -n "$found" ] || [ "$retired" -ne 0 ] || [ -n "$broken" ]; then
  exit 1
fi
if [ -n "$unread" ]; then
  outage "these images could not be read:$unread"
fi
echo "every image is clean outside its allowlist, and every allowlist entry is still needed."
