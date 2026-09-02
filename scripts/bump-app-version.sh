#!/usr/bin/env bash
# Bumps the Canari app version across frontend package.json, Tauri config, crate manifests and the
# two iOS files Tauri does not own.
#
# Usage: scripts/bump-app-version.sh 0.15.0
#        scripts/bump-app-version.sh 0.15.0-alpha.1
#
# THREE DIFFERENT STRINGS COME OUT OF ONE ARGUMENT, and conflating any two of them breaks a store
# upload rather than a build - which is why they are computed once, here, and never re-derived by a
# workflow:
#
#   VERSION      the full `0.15.0-alpha.1`. Goes into every package.json, every Cargo.toml and every
#                Cargo.lock, all of which accept a semver pre-release. `frontend/package.json` is
#                also what the CLIENT identifies itself by - `vite.config.js` defines
#                VITE_APP_VERSION from it - so `minClientVersion` compares against this one.
#   CORE         the numeric `0.15.0`. Goes into tauri.conf.json, because Tauri copies that value
#                into CFBundleShortVersionString and APPLE REQUIRES THE SHORT VERSION TO BE NUMERIC.
#                A suffix there is an App Store validation failure, not a cosmetic difference.
#   VERSION_CODE the band `1500001`. One integer for BOTH stores: Android's versionCode and iOS's
#                CFBundleVersion. Left alone Tauri derives major*1e6 + minor*1e3 + patch (that is
#                where today's 14004 comes from) which IGNORES the suffix entirely, so -alpha.1 and
#                -alpha.2 would ask Play to accept the same code twice, and Play refuses.
#
# THE BAND IS (major*1e6 + minor*1e3 + patch) * 100 + RANK, with RANK = N for `-alpha.N` and 99 for
# a stable. 99 and not 0: rank 0 would put `0.15.0` BELOW every alpha of `0.15.0`, and a store
# refuses a code it has already accepted. The order that matters reads
# `0.15.0-alpha.1` 1500001 < `0.15.0-alpha.98` 1500098 < `0.15.0` 1500099 < `0.15.1-alpha.1`
# 1500101. Today's 0.14.15 is 14015, so the whole band steps up by a factor of 100 exactly once and
# stays monotonic for ever after; the ceiling (0.999.999 -> 99999999) is well inside the 2100000000
# Play allows. N is capped at 98 for that reason - an alpha.99 would collide with its own stable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage: $0 <major.minor.patch[-alpha.N]>" >&2
  exit 1
}

# Sets VERSION, CORE, RANK and VERSION_CODE from one argument. Exits on anything it cannot parse:
# a bump that guesses is worse than a release that fails at its first step.
parse_version() {
  local raw="${1#v}"
  local core suffix rank major minor patch
  if [[ "$raw" =~ ^([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    core="${BASH_REMATCH[1]}"
    rank=99
    suffix=""
  elif [[ "$raw" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-alpha\.([0-9]+)$ ]]; then
    core="${BASH_REMATCH[1]}"
    suffix="${BASH_REMATCH[2]}"
    rank="$((10#$suffix))"
    if [ "$rank" -lt 1 ] || [ "$rank" -gt 98 ]; then
      echo "Invalid pre-release counter: $1 (alpha.N must be 1..98; 99 is reserved for the stable)" >&2
      exit 1
    fi
  else
    echo "Invalid version: $1 (expected major.minor.patch or major.minor.patch-alpha.N)" >&2
    exit 1
  fi

  IFS='.' read -r major minor patch <<< "$core"
  if [ "$minor" -gt 999 ] || [ "$patch" -gt 999 ]; then
    echo "Invalid version: $1 (minor and patch must each stay under 1000 for the versionCode band)" >&2
    exit 1
  fi

  VERSION="$raw"
  CORE="$core"
  RANK="$rank"
  VERSION_CODE="$(( (major * 1000000 + minor * 1000 + patch) * 100 + rank ))"
  if [ "$VERSION_CODE" -gt 2100000000 ]; then
    echo "versionCode $VERSION_CODE exceeds the 2100000000 Play allows" >&2
    exit 1
  fi
}

# JQ ON WINDOWS WRITES CRLF, AND STRIPPING CR IS THE SAFE ANSWER ON JSON SPECIFICALLY.
# Measured 2026-09-01 under Git Bash: `echo '{"a":1}' | jq .` comes back with every newline as CRLF,
# while the awk-based bumps below come back LF. That is exactly why one version bump left CRLF in
# the four service `package.json` files and in `tauri.conf.json` and in nothing else - those are the
# two functions here that use jq.
#
# IT IS INVISIBLE TO GIT. The repository declares `* text=auto eol=lf`, so the blob is normalised
# and `git status` shows nothing modified; the damage surfaced only as `lineEndings.test.ts` failing
# a push, naming five files nobody had knowingly touched.
#
# Safe on JSON because an unescaped carriage return is not legal inside a JSON string - jq emits a
# real one as the two characters backslash and `r` - so no CR reaching this filter is data.
strip_cr() { tr -d '\r'; }

bump_package_json() {
  local file="$1"
  local version="$2"
  if ! jq -e '.version' "$file" >/dev/null 2>&1; then
    echo "  skip (no .version field): $file" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  jq --arg v "$version" '.version = $v' "$file" | strip_cr > "$tmp"
  mv "$tmp" "$file"
  echo "  package.json  $file → $version"
}

bump_tauri_conf() {
  # THE NUMERIC CORE, NEVER THE FULL VERSION - Tauri copies this value into
  # CFBundleShortVersionString, and Apple requires the short version to be numeric.
  #
  # `bundle.android.versionCode` is written EXPLICITLY because Tauri's default is
  # `major*1e6 + minor*1e3 + patch`, which cannot see a pre-release suffix at all: every alpha of
  # 0.15.0 would derive 15000 and Play refuses the second upload. Writing it also puts the number
  # next to the version it belongs to instead of inside a build nobody reads.
  local file="$1"
  local core="$2"
  local version_code="$3"
  local tmp
  tmp="$(mktemp)"
  jq --arg v "$core" --argjson vc "$version_code" '.version = $v | .bundle.android.versionCode = $vc' "$file" | strip_cr > "$tmp"
  mv "$tmp" "$file"
  echo "  tauri.conf    $file → $core (android versionCode $version_code)"
}

bump_cargo_package_version() {
  local file="$1"
  local version="$2"
  if ! grep -q '^version = ' "$file"; then
    echo "  skip (no [package].version): $file" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  awk -v ver="$version" '
    /^version = / && !done { sub(/"[^"]*"/, "\"" ver "\""); done=1 }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  Cargo.toml    $file → $version"
}

bump_ios_nse_pbxproj() {
  # The iOS Notification Service Extension (CanariNotifications) is its own Xcode
  # target that Tauri does not know about, so `tauri ios build` never syncs its
  # version from tauri.conf.json. Its MARKETING_VERSION / CURRENT_PROJECT_VERSION
  # build settings (which GENERATE_INFOPLIST_FILE=YES turns into the appex
  # CFBundleShortVersionString / CFBundleVersion) must match the parent app or App
  # Store validation rejects the .ipa. Keep them in lockstep with the app version.
  #
  # THE TWO SETTINGS TAKE DIFFERENT VALUES SINCE 2026-09-03, because they answer different
  # questions: MARKETING_VERSION is the short version Apple requires to be numeric, and
  # CURRENT_PROJECT_VERSION is the BUILD number, which must differ between two TestFlight uploads
  # of one short version. Giving both the same string made every alpha of a release collide.
  local file="$1"
  local core="$2"
  local version_code="$3"
  if [ ! -f "$file" ]; then
    echo "  skip (no pbxproj): $file" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  sed -E \
    -e "s/(MARKETING_VERSION = )[^;]*;/\1${core};/" \
    -e "s/(CURRENT_PROJECT_VERSION = )[^;]*;/\1${version_code};/" \
    "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  pbxproj (NSE) $file → $core (build $version_code)"
}

bump_ios_app_infoplist() {
  # The app target's Info.plist hardcodes CFBundleShortVersionString/CFBundleVersion
  # literals (no MARKETING_VERSION build setting on that target - it does not use
  # GENERATE_INFOPLIST_FILE). `tauri ios build` re-syncs them from tauri.conf.json
  # during the build, but an early xcodebuild pass links the NSE against the stale
  # committed literals and warns "CFBundleVersion of an app extension must match its
  # containing parent app". Keeping the committed plist in lockstep kills the warning
  # and removes the dependency on Tauri's in-build rewrite.
  #
  # SHORT VERSION AND BUILD NUMBER ARE NOT THE SAME STRING. CFBundleShortVersionString is what the
  # App Store shows and must be numeric; CFBundleVersion is the build number and must be unique per
  # upload of that short version, which is exactly what a pre-release counter needs. It takes the
  # same band Android's versionCode does, so ONE number identifies a build on both stores.
  #
  # WHAT IS NOT SETTLED FROM A WINDOWS BOX: `tauri ios build` re-syncs both keys from
  # tauri.conf.json during the build, and Tauri 2.11.4 exposes no iOS build-number override - so
  # this committed value may be overwritten on the runner. `ios-release.yml` already patches this
  # plist with PlistBuddy for the export-compliance code; if a TestFlight upload is ever refused as
  # a duplicate build, that is where CFBundleVersion is re-asserted. Only a macOS run can say
  # whether it has to be, so nothing is written against the guess.
  local file="$1"
  local core="$2"
  local version_code="$3"
  if [ ! -f "$file" ]; then
    echo "  skip (no Info.plist): $file" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  awk -v short_ver="$core" -v build_ver="$version_code" '
    /<key>CFBundleShortVersionString<\/key>/ { print; getline; sub(/<string>[^<]*<\/string>/, "<string>" short_ver "</string>"); print; next }
    /<key>CFBundleVersion<\/key>/ { print; getline; sub(/<string>[^<]*<\/string>/, "<string>" build_ver "</string>"); print; next }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  Info.plist (app) $file → $core (build $version_code)"
}

cargo_package_name() {
  # First `name = "..."` in a manifest is the [package] name (the file starts with
  # [package]); dependency tables come later.
  local file="$1"
  sed -n 's/^name = "\([^"]*\)".*/\1/p' "$file" | head -n 1
}

bump_cargo_lock_version() {
  # Cargo.lock pins the version of every LOCAL crate too, and a lock does not live
  # next to the crate it pins: mls-core is pinned in src-tauri's lock, and a workspace
  # member in its workspace's. Left alone, those entries lag a release behind until some unrelated
  # commit happens to run cargo and sweeps the regenerated lock in. Patch every block
  # whose package name is one we just bumped.
  local file="$1"
  local version="$2"
  local names="$3" # space-delimited, space-padded
  if [ ! -f "$file" ]; then
    return
  fi
  local tmp
  tmp="$(mktemp)"
  awk -v ver="$version" -v names="$names" '
    /^\[\[package\]\]/ { local_pkg = 0 }
    /^name = "/ {
      pkg = $0
      sub(/^name = "/, "", pkg)
      sub(/".*$/, "", pkg)
      local_pkg = (index(names, " " pkg " ") > 0)
    }
    local_pkg && /^version = "/ { sub(/"[^"]*"/, "\"" ver "\""); local_pkg = 0 }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  Cargo.lock    $file → $version"
}

discover_package_json_files() {
  local -a files=("$ROOT/frontend/package.json")
  local pkg

  shopt -s nullglob
  for pkg in "$ROOT"/apps/*/package.json; do
    files+=("$pkg")
  done
  for pkg in "$ROOT"/libs/*/package.json; do
    files+=("$pkg")
  done
  shopt -u nullglob

  printf '%s\n' "${files[@]}" | LC_ALL=C sort -u
}

discover_cargo_files() {
  local -a files=(
    "$ROOT/frontend/src-tauri/Cargo.toml"
    "$ROOT/frontend/mls-wasm/Cargo.toml"
    "$ROOT/frontend/mls-core/Cargo.toml"
  )
  local cargo

  shopt -s nullglob
  for cargo in "$ROOT"/apps/*/Cargo.toml; do
    files+=("$cargo")
  done
  shopt -u nullglob

  printf '%s\n' "${files[@]}" | LC_ALL=C sort -u
}

RAW_VERSION="${1:-}"
[ -n "$RAW_VERSION" ] || usage
parse_version "$RAW_VERSION"

echo "Bumping Canari app version to ${VERSION}"
echo "  manifests ${VERSION} | stores: short ${CORE}, build/versionCode ${VERSION_CODE} (rank ${RANK})"

while IFS= read -r f; do
  [ -f "$f" ] || { echo "Missing: $f" >&2; exit 1; }
  bump_package_json "$f" "$VERSION"
done < <(discover_package_json_files)

TAURI_CONF="$ROOT/frontend/src-tauri/tauri.conf.json"
[ -f "$TAURI_CONF" ] || { echo "Missing: $TAURI_CONF" >&2; exit 1; }
bump_tauri_conf "$TAURI_CONF" "$CORE" "$VERSION_CODE"

bump_ios_nse_pbxproj "$ROOT/frontend/src-tauri/gen/apple/canari.xcodeproj/project.pbxproj" "$CORE" "$VERSION_CODE"

bump_ios_app_infoplist "$ROOT/frontend/src-tauri/gen/apple/canari_iOS/Info.plist" "$CORE" "$VERSION_CODE"

LOCAL_CRATES=" "
while IFS= read -r f; do
  [ -f "$f" ] || { echo "Missing: $f" >&2; exit 1; }
  bump_cargo_package_version "$f" "$VERSION"
  LOCAL_CRATES="${LOCAL_CRATES}$(cargo_package_name "$f") "
done < <(discover_cargo_files)

# Every lock sits next to a manifest we just bumped; a crate with no lock of its own
# (mls-core) is still patched inside its consumer's, via LOCAL_CRATES.
while IFS= read -r f; do
  bump_cargo_lock_version "$(dirname "$f")/Cargo.lock" "$VERSION" "$LOCAL_CRATES"
done < <(discover_cargo_files)

echo "Done."
