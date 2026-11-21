#!/usr/bin/env bash
#
# WHEN AN IMAGE-SCAN ALLOWLIST ENTRY IS DEAD - decided on a fact about OUR image, never on the feed.
#
# The first form of this check (`ignored-advisories-still-reported.sh`) called an entry dead when the
# scanner stopped REPORTING its advisory. That is a fact about the scanner's advisory data, and that
# data comes and goes: the gosu entry `CVE-2026-97054` was added (#3855), deleted as dead (#3895),
# put back when the scanner reported it again (#3930) and then failed every pull request when it
# stopped once more. A check whose verdict flips with the feed fails builds for nothing and teaches
# its readers to delete the entry, which is the hole the check exists to close.
#
# THE RULE. Every entry names the package version it was written for (`purls:` or `covers:`; see
# `image-scan-allowlist.yaml`). An entry is judged on that `id package version` triple, against what
# the scan JSON carries (`--list-all-pkgs`):
#   - the triple is REPORTED                    -> the entry is needed. Silent.
#   - NOT reported, package still in an image   -> a plain log line, no failure. The advisory was
#       dropped, rescored below HIGH or lost its fixed version (the scan filters on both), but the package version the entry was reviewed on still ships, so the
#       suppression still covers exactly what was assessed. The line names the database version.
#   - NOT reported, package version in NO image -> DEAD, exit 1. The image moved: the reviewed code
#       is gone, and a suppression left behind would hide that advisory on whatever replaced it.
# HOW FAR THE SCOPE REACHES, honestly. A `purls:` entry is enforced by Trivy itself: one advisory id on
# one package version, so a new version is outside it. A `paths:`-scoped or id-only entry is NOT:
# Trivy ignores `covers:`, so such an entry still suppresses that id on ANY version at that path (or
# anywhere), and `covers:` only tells THIS check what the entry was reviewed on. The inventory is also
# pooled across all scanned images: a covered package present in another image keeps the entry alive.
# Both are closed by putting the version into `purls:` (follow-up).
#
# THE TEST THAT LIFTS A REFUSAL: delete the entry (the image no longer carries what it covers), or, if
# you believe the image still carries it, show it - `trivy image --list-all-pkgs --format json <image>`
# must list the package at that version; the scan inventory is the evidence, and it is wrong if not.
#
# Usage: image-allowlist-retirement.sh <scan json (one or many objects)> <covers file> [database note]
#   covers file: one `<id> <package> <version>` per line (`image-scan.sh --allowlist-covers`)
# Exit:  0 no entry is dead (kept-entry lines may have been printed); 1 one is dead, or the scan JSON is empty
#        or the covers file names nothing (an empty answer is a silent registry, never proof).
set -uo pipefail

json="${1:?usage: image-allowlist-retirement.sh <scan json> <covers file> [database note]}"
covers="${2:?usage: image-allowlist-retirement.sh <scan json> <covers file> [database note]}"
db="${3:-an unreadable Trivy database}"

[ -s "$json" ] || { echo "::error::the un-ignored scan printed nothing, so it cannot say whether any allowlist entry is still needed. Not granted."; exit 1; }
[ -s "$covers" ] || { echo "::error::no allowlist entry names a package it covers, so there is nothing to check"; exit 1; }

reported="$(jq -r '.Results[]?.Vulnerabilities[]? | "\(.VulnerabilityID) \(.PkgName) \(.InstalledVersion)"' "$json" | sort -u)"
# Every `package version` the images carry; a package with a release is listed with and without it.
inventory="$(jq -r '.Results[]?.Packages[]? | "\(.Name) \(.Version)", (select(.Release != null and .Release != "") | "\(.Name) \(.Version)-\(.Release)")' "$json" | sort -u)"
[ -n "$inventory" ] || { echo "::error::the scan JSON lists no package (was it run without --list-all-pkgs?), so no entry can be judged. Not granted."; exit 1; }

dead=""
unlisted=0
while read -r id name version; do
  [ -n "$id" ] || continue
  if grep -qxF -- "$id $name $version" <<<"$reported"; then
    continue
  elif grep -qxF -- "$name $version" <<<"$inventory"; then
    # A plain log line, never an annotation: it is expected, and a line every run prints as a warning
    # is noise. The causes are NOT told apart here: the scan runs with --severity HIGH,CRITICAL and
    # --ignore-unfixed, so a dropped advisory, a rescore below HIGH and a lost fixed version look alike.
    echo "    $id: not reported on $name $version by $db (dropped, rescored below HIGH, or no fixed version any more), but that package version is still in a scanned image: kept."
    unlisted=$((unlisted + 1))
  else
    dead="$dead
    $id on $name $version"
  fi
done <"$covers"

if [ -n "$dead" ]; then
  printf '    no scanned image carries the package version these entries cover:%s\n' "$dead"
  echo "::error::an allowlist entry covers a package version that NO scanned image carries any more - the image moved, so delete that entry (or purl). To keep it, the scan inventory (trivy image --list-all-pkgs) must list that package at that version."
  exit 1
fi
echo "    every allowlist entry covers a package version an image still carries ($unlisted not reported by the current advisory data, listed above)."
