#!/usr/bin/env bash
#
# THE IMAGES THE IMAGE SCAN READS, DERIVED FROM THE FILES THAT RUN THEM - never a list kept by hand.
# A hand list is the failure mode `lib/ceiling.sh` already paid for: an image added to a compose file
# and not to the list is an image nothing scans, and the symptom is an absence.
#
# Two sources, one image reference per line, sorted and unique:
#
#   1. THE RUNTIME BASE of every `infrastructure/local/Dockerfile.*` - the LAST `FROM`, the stage that
#      ships. A builder stage (`rust:slim-bookworm`, the bun builder) never reaches an estate, so a
#      CVE in it is not one an estate carries.
#   2. EVERY THIRD-PARTY `image:` of the compose files an estate runs - production's, dev's and the
#      identity provider's. `${VAR:-default}` is read as its default, which is what the file runs
#      when the host sets nothing. This repository's OWN images (`ghcr.io/emse-students/canari/*`)
#      are left out: they are built from the Dockerfiles above at release time, and their bases are
#      item 1. `infrastructure/local/docker-compose.yml` is a developer's machine, not an estate.
#
# Usage: image-scan-targets.sh [repository root]   (defaults to this script's repository)
# Exit:  0 with the list on stdout; 1 when a source is missing, yields nothing, or names an image
#        through a variable with no default.
set -euo pipefail

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
own_prefix='ghcr.io/emse-students/canari/'

dockerfiles=("$root"/infrastructure/local/Dockerfile.*)
composes=(
  "$root/infrastructure/docker-compose.prod.yml"
  "$root/infrastructure/docker-compose.dev.yml"
  "$root/infrastructure/authentik/compose.yml"
)

for f in "${dockerfiles[@]}" "${composes[@]}"; do
  [ -f "$f" ] || { echo "::error::image-scan-targets: $f is not in the tree, so the images it runs cannot be scanned" >&2; exit 1; }
done

list="$(
  for f in "${dockerfiles[@]}"; do
    # The last FROM is the shipped stage; `--platform=...` and `AS name` are not the reference.
    awk 'toupper($1) == "FROM" { for (i = 2; i <= NF; i++) { if ($i ~ /^--/) continue; ref = $i; break } } END { print ref }' "$f"
  done
  for f in "${composes[@]}"; do
    awk '$1 == "image:" { print $2 }' "$f" |
      sed -E -e "s/^[\"']//" -e "s/[\"']\$//" -e 's/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/\1/g'
  done
)"
list="$(printf '%s\n' "$list" | grep -v '^$' | grep -vF "$own_prefix" | sort -u || true)"

if [ -z "$list" ]; then
  echo "::error::image-scan-targets: no image was read out of the Dockerfiles and compose files; the parse is broken, not the estate" >&2
  exit 1
fi
# A reference still carrying `${` interpolates a variable with no default: nothing can say what it runs.
# shellcheck disable=SC2016 # the literal `${` is what is searched for, not an expansion.
if printf '%s\n' "$list" | grep -F '${' >&2; then
  echo "::error::image-scan-targets: the reference above interpolates a variable with no default, so the image it runs cannot be named" >&2
  exit 1
fi
printf '%s\n' "$list"
