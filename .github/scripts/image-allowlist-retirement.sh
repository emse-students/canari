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
# THE RULE. Every entry names the package version it was written for (`purls:`, see
# `image-scan-allowlist.yaml`). An entry is judged on that `id package version` triple, against what
# the scan JSON carries (`--list-all-pkgs`):
#   - the triple is REPORTED                    -> the entry is needed. Silent.
#   - NOT reported, package still in an image   -> a plain log line, no failure. The advisory was
#       dropped, rescored below HIGH or lost its fixed version (the scan filters on both), but the
#       package version the entry was reviewed on still ships, so the
#       suppression still covers exactly what was assessed. The line names the database version.
#   - NOT reported, package version in NO image -> DEAD, exit 1. The image moved: the reviewed code
#       is gone, and a suppression left behind would hide that advisory on whatever replaced it.
# HOW FAR THE SCOPE REACHES. Every entry names the package version in `purls:`, which TRIVY enforces
# (one advisory id on one package version; a new version is outside it), and `paths:` further
# restricts it (the two combine as an AND). This check judges exactly that scope: an entry with `paths:`
# is alive only on a package at those paths. An entry with a purl and no `paths:` is pooled across all
# scanned images, as its `statement` names them.
#
# THE TEST THAT LIFTS A REFUSAL: delete the entry (the image no longer carries what it covers), or, if
# you believe the image still carries it, show it - `trivy image --list-all-pkgs --format json <image>`
# must list the package at that version; the scan inventory is the evidence, and it is wrong if not.
#
# Usage: image-allowlist-retirement.sh <scan json (one or many objects)> <covers file> [database note]
#   covers file: one `<id> <package> <version> <paths, comma-joined, or ->` per line
#   (`image-scan.sh --allowlist-covers`)
# Exit:  0 no entry is dead (kept-entry lines may have been printed); 1 one is dead, or the scan JSON is empty
#        or the covers file names nothing (an empty answer is a silent registry, never proof).
set -uo pipefail

json="${1:?usage: image-allowlist-retirement.sh <scan json> <covers file> [database note]}"
covers="${2:?usage: image-allowlist-retirement.sh <scan json> <covers file> [database note]}"
db="${3:-an unreadable Trivy database}"

[ -s "$json" ] || { echo "::error::the un-ignored scan printed nothing, so it cannot say whether any allowlist entry is still needed. Not granted."; exit 1; }
[ -s "$covers" ] || { echo "::error::no allowlist entry names a package it covers, so there is nothing to check"; exit 1; }

# Both sets carry WHERE each package sits (its file path, and the scan target it came from), so an
# entry scoped by `paths:` is judged only against packages at those paths: the same package name in
# another image, or at another path, cannot keep it alive. A deb with an epoch is listed with and
# without it (`purls:` carry no epoch; Trivy's installed version does), a release with and without.
reported="$(jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]? | ([.VulnerabilityID, .PkgName, .InstalledVersion, (.PkgPath // $t)] | @tsv), ([.VulnerabilityID, .PkgName, (.InstalledVersion | sub("^[0-9]+:"; "")), (.PkgPath // $t)] | @tsv)' "$json" | tr -d '\r' | sort -u)"
inventory="$(jq -r '.Results[]? | .Target as $t | .Packages[]? | . as $p
  | [($p.Version // ""), (if ($p.Release // "") != "" then "\($p.Version)-\($p.Release)" else empty end)] | .[] as $ver
  | (if ($p.Epoch // 0) > 0 then ["\($p.Epoch):\($ver)", $ver] else [$ver] end) | .[] as $full
  | [$p.Name, $full, ($p.FilePath // $t)], [$p.Name, $full, $t] | @tsv' "$json" | tr -d '\r' | sort -u)"
[ -n "$inventory" ] || { echo "::error::the scan JSON lists no package (was it run without --list-all-pkgs?), so no entry can be judged. Not granted."; exit 1; }

# present <rows> <key fields> <key> <globs>: is there a row whose first fields equal the key and whose
# LAST field (a path or target) matches one of the comma-separated globs (`-` = any)?
present() {
  awk -F'\t' -v nk="$2" -v key="$3" -v globs="$4" '
    BEGIN { n = split(globs, g, ","); for (i = 1; i <= n; i++) { r = g[i]; gsub(/[.]/, "[.]", r); gsub(/\*+/, ".*", r); re[i] = "^" r "$" } }
    {
      k = $1; for (j = 2; j <= nk; j++) k = k "\t" $j
      if (k != key) next
      if (globs == "-") { found = 1; exit }
      for (i = 1; i <= n; i++) if ($NF ~ re[i]) { found = 1; exit }
    }
    END { exit !found }
  ' <<<"$1"
}

dead=""
unlisted=0
while read -r id name version globs; do
  [ -n "$id" ] || continue
  if present "$reported" 3 "$(printf '%s\t%s\t%s' "$id" "$name" "$version")" "$globs"; then
    continue
  elif present "$inventory" 2 "$(printf '%s\t%s' "$name" "$version")" "$globs"; then
    # A plain log line, never an annotation: it is expected, and a line every run prints as a warning
    # is noise. The causes are NOT told apart here: the scan runs with --severity HIGH,CRITICAL and
    # --ignore-unfixed, so a dropped advisory, a rescore below HIGH and a lost fixed version look alike.
    echo "    $id: not reported on $name $version by $db (dropped, rescored below HIGH, or no fixed version any more), but that package version is still in a scanned image: kept."
    unlisted=$((unlisted + 1))
  else
    dead="$dead
    $id on $name $version$([ "$globs" = - ] || printf ' %s' "$globs")"
  fi
done <"$covers"

if [ -n "$dead" ]; then
  printf '    no scanned image carries the package version these entries cover:%s\n' "$dead"
  echo "::error::an allowlist entry covers a package version that NO scanned image carries any more - the image moved, so delete that entry (or purl). To keep it, the scan inventory (trivy image --list-all-pkgs) must list that package at that version."
  exit 1
fi
echo "    every allowlist entry covers a package version an image still carries ($unlisted not reported by the current advisory data, listed above)."
