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
#        image-scan.sh --upgraded-packages <Dockerfile> / --shipped-base <Dockerfile>  (the readers; no network)
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

# THE PACKAGES A `dockerfile:` TARGET UPGRADES PAST ITS BASE, one per line: the words after `upgrade`
# in each `apk`/`apt-get`/`apt` upgrade of the shipped stage (the last `FROM`), up to the end of that
# command, its options left out. Docker's own line continuation is honoured first: a line ending in a
# backslash is joined to the next (a comment line inside it dropped, as Docker does), so a package
# list spread over several lines is read whole. A word is cut at a trailing backslash, `;` or `&&`
# (`libpq\`, `libpq;`): the part before it is the package, and `;` or `&&` also ends the command, as
# a separate `&&`, `||` or `;` does. An upgrade naming no package (`apk upgrade` alone) prints
# nothing: it moves everything, and no single package can be called a no-op.
# Usage: upgraded_packages <Dockerfile>
upgraded_packages() {
  awk '
    function parse(line,    n, w, i, j, word, ends) {
      n = split(line, w, /[[:space:]]+/)
      if (toupper(w[1]) == "FROM" || (w[1] == "" && toupper(w[2]) == "FROM")) { split("", pkgs); return }
      for (i = 1; i < n; i++) {
        if ((w[i] == "apk" || w[i] == "apt-get" || w[i] == "apt") && w[i + 1] == "upgrade") {
          for (j = i + 2; j <= n; j++) {
            word = w[j]
            if (word == "&&" || word == "||" || word == ";") break
            ends = (word ~ /(;|&&)$/)
            sub(/(\\|;|&&)+$/, "", word)
            if (word != "" && word !~ /^-/) pkgs[word] = 1
            if (ends) break
          }
        }
      }
    }
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    /\\[[:space:]]*$/ { line = $0; sub(/\\[[:space:]]*$/, " ", line); joined = joined line; next }
    { parse(joined $0); joined = "" }
    END { if (joined != "") parse(joined); for (p in pkgs) print p }
  ' "$1" | sort -u
}

# THE IMAGE THE SHIPPED STAGE STARTS FROM, as a registry reference: the last `FROM`, followed through
# an earlier stage it names (`FROM base` after `FROM nginx:x AS base`) and through the `ARG` defaults
# declared before the first `FROM` (`${TAG}`, `$TAG`). Prints `SKIP <reason>` when no reference can be
# named - an `ARG` with no default, `${X:-y}`, `scratch` - so the caller logs why it did not compare,
# rather than reading an outage into a reference that was never an image.
# Usage: shipped_base <Dockerfile>
shipped_base() {
  awk '
    function resolve(r,    n, k, pre, post) {
      for (n = 0; n < 20; n++) {
        if (tolower(r) in stage) { r = stage[tolower(r)]; continue }
        if (match(r, /\$\{[A-Za-z_][A-Za-z0-9_]*\}/)) { k = substr(r, RSTART + 2, RLENGTH - 3) }
        else if (match(r, /\$[A-Za-z_][A-Za-z0-9_]*/)) { k = substr(r, RSTART + 1, RLENGTH - 1) }
        else break
        if (!(k in args)) break
        pre = substr(r, 1, RSTART - 1); post = substr(r, RSTART + RLENGTH); r = pre args[k] post
      }
      return r
    }
    { sub(/\r$/, "") }
    toupper($1) == "ARG" && !from_seen { eq = index($2, "="); if (eq > 0) args[substr($2, 1, eq - 1)] = substr($2, eq + 1) }
    toupper($1) == "FROM" {
      from_seen = 1; ref = ""
      for (i = 2; i <= NF; i++) { if ($i ~ /^--/) continue; ref = $i; break }
      for (i = 2; i < NF; i++) if (toupper($i) == "AS") { stage[tolower($(i + 1))] = ref }
      last = ref
    }
    END {
      r = resolve(last)
      if (r ~ /\$/) print "SKIP the shipped stage starts from " last ", which names a build argument with no default here"
      else if (tolower(r) == "scratch") print "SKIP the shipped stage starts from scratch, which carries no package"
      else print r
    }
  ' "$1"
}

# The two readers above, alone, for `image-scan-targets.test.sh` (no network, no trivy).
if [ "${1:-}" = '--upgraded-packages' ]; then
  upgraded_packages "$2"
  exit 0
fi
if [ "${1:-}" = '--shipped-base' ]; then
  shipped_base "$2"
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

# THE CONTEXT A `dockerfile:` BUILD READS: exactly the sources its `COPY`/`ADD` lines name (not a
# `--from` stage's), copied from the repository into a fresh directory, whose path is printed.
# A source the checkout does not hold is a build OUTPUT the release produces before it builds
# (`frontend/build`, downloaded from `build-frontend` in `build.yml`), and this job does not produce
# it. It is staged EMPTY only when git IGNORES that path - the proof it is an output and not a source
# of ours: the packages the scan reads come from the base and the `RUN` lines, and that output's code
# is what the lockfile audits read. A missing source git does NOT ignore is a typo the release would
# meet too, so it fails the staging and the run (exit 1), like a build that fails.
# ONLY THE PLAIN FORM `COPY [--flag...] <src>... <dest>` IS READ. The JSON form (`COPY ["a", "b"]`),
# a heredoc (`COPY <<EOF`), a glob (`*`, `?`, `[`) and a remote `ADD <url>` are REFUSED by name, so the
# run fails with "could not be staged" (exit 1) instead of building from a context that silently lacks
# a source. None is used today; the first file that needs one extends this reader, and
# `image-scan-targets.test.sh` holds each refusal.
# Usage: stage_context <Dockerfile> <directory to create>
stage_context() {
  local dockerfile="$1" dir="$2" src
  mkdir -p "$dir" || return 1
  while read -r src; do
    [ -n "$src" ] || continue
    if [ "${src%% *}" = 'REFUSED' ]; then
      echo "    ${dockerfile##*/}: ${src#REFUSED } is a COPY/ADD form this reader does not stage" >&2
      return 1
    fi
    mkdir -p "$dir/$(dirname "$src")" || return 1
    if [ -e "$root/$src" ]; then
      cp -R "$root/$src" "$dir/$src" || return 1
    elif git -C "$root" check-ignore -q "$src"; then
      echo "    $src is a build output this checkout does not hold (git ignores it): staged empty" >&2
      mkdir -p "$dir/$src" || return 1
    else
      echo "    $src, copied by ${dockerfile##*/}, is not in the tree and git does not ignore it" >&2
      return 1
    fi
  done < <(awk '
    toupper($1) == "COPY" || toupper($1) == "ADD" {
      n = 0; from = 0
      for (i = 2; i <= NF; i++) { if ($i ~ /^--from=/) from = 1; else if ($i !~ /^--/) args[++n] = $i }
      if (from) next
      if (args[1] ~ /^\[/) { print "REFUSED the JSON form"; next }
      for (i = 1; i < n; i++) {
        if (args[i] ~ /^<</) print "REFUSED a heredoc"
        else if (args[i] ~ /^[A-Za-z][A-Za-z0-9+.-]*:\/\//) print "REFUSED a remote source (" args[i] ")"
        else if (args[i] ~ /[*?[]/) print "REFUSED a glob (" args[i] ")"
        else print args[i]
      }
    }
  ' "$dockerfile")
  printf '%s\n' "$dir"
}

common=(--quiet --skip-db-update --scanners vuln --severity 'HIGH,CRITICAL' --ignore-unfixed)
root="$(cd "$here/../.." && pwd)"
found=""
unread=""
broken=""
while IFS= read -r target; do
  echo "--- $target"
  # `dockerfile:<path>` is an image whose shipped stage upgrades its base's packages, so its base is
  # not what an estate runs (`image-scan-targets.sh`): it is BUILT here, from the same file and the
  # context `stage_context` builds from its COPY lines, and the local result is scanned. Every other target is a reference
  # Trivy reads from its registry. A build that fails is a FINDING (exit 1), never an outage: the file
  # is ours, and an image we cannot build is one the release cannot ship (review of #3442) - exit 2
  # stays for the registry and the database alone.
  # `</dev/null`: docker must not read this loop's list as its own stdin.
  case "$target" in
    dockerfile:*)
      path="${target#dockerfile:}"
      name="${path##*/Dockerfile.}"
      image="canari-image-scan/$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]'):local"
      if ! context="$(stage_context "$root/$path" "$work/context-$name")"; then
        echo "    $path could not be staged"
        broken="$broken $target"
        continue
      fi
      if ! DOCKER_BUILDKIT=1 docker build --quiet --no-cache --file "$root/$path" --tag "$image" "$context" </dev/null >/dev/null; then
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
  # AN UPGRADE THE BASE NO LONGER NEEDS IS REPORTED (review of #3915). The built image is clean either
  # way, so nothing else would ever say that upstream shipped the fix and the line can go: the BARE
  # base is scanned without the allowlist, and a package the file upgrades on which the base reports
  # no fixable HIGH/CRITICAL advisory any more is a no-op, named in a warning. It does not fail the
  # run - the image is right, only the file is longer than it needs to be.
  case "$target" in
    dockerfile:*)
      base="$(shipped_base "$root/$path")"
      packages="$(upgraded_packages "$root/$path")"
      if [ -z "$packages" ]; then
        echo "    $path upgrades no named package, so no line of it can be called a no-op"
      elif [ "${base%% *}" = 'SKIP' ]; then
        echo "    $path: its upgrades are not compared with a base - ${base#SKIP }"
      elif trivy image "${common[@]}" --image-src remote --exit-code 0 --format json --output "$work/base-$name.json" "$base"; then
        while read -r package; do
          if jq -e --arg p "$package" '[.Results[]?.Vulnerabilities[]? | select(.PkgName == $p)] | length > 0' "$work/base-$name.json" >/dev/null; then
            echo "    $package: its base $base still needs the upgrade"
          else
            echo "::warning title=Image scan, an upgrade is likely a no-op::no fixable HIGH/CRITICAL advisory left on $package in $base: the upgrade of $package in $path is likely a no-op, check and delete it (and the file, if it was the last). Only that package name was compared, not the advisory the line was written for."
          fi
        done <<< "$packages"
      else
        unread="$unread $base(base of $path)"
      fi
      ;;
  esac
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
