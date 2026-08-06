#!/usr/bin/env bash
# Bumps the Canari app semver across frontend package.json, Tauri config, and crate manifests.
# Usage: scripts/bump-app-version.sh 0.3.6
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage: $0 <major.minor.patch>" >&2
  exit 1
}

normalize_version() {
  local raw="${1#v}"
  if ! [[ "$raw" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Invalid semver: $1 (expected major.minor.patch)" >&2
    exit 1
  fi
  echo "$raw"
}

bump_package_json() {
  local file="$1"
  local version="$2"
  if ! jq -e '.version' "$file" >/dev/null 2>&1; then
    echo "  skip (no .version field): $file" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  jq --arg v "$version" '.version = $v' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  package.json  $file → $version"
}

bump_tauri_conf() {
  local file="$1"
  local version="$2"
  local tmp
  tmp="$(mktemp)"
  jq --arg v "$version" '.version = $v' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  tauri.conf    $file → $version"
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
  local file="$1"
  local version="$2"
  if [ ! -f "$file" ]; then
    echo "  skip (no pbxproj): $file" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  sed -E \
    -e "s/(MARKETING_VERSION = )[^;]*;/\1${version};/" \
    -e "s/(CURRENT_PROJECT_VERSION = )[^;]*;/\1${version};/" \
    "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  pbxproj (NSE) $file → $version"
}

bump_ios_app_infoplist() {
  # The app target's Info.plist hardcodes CFBundleShortVersionString/CFBundleVersion
  # literals (no MARKETING_VERSION build setting on that target - it does not use
  # GENERATE_INFOPLIST_FILE). `tauri ios build` re-syncs them from tauri.conf.json
  # during the build, but an early xcodebuild pass links the NSE against the stale
  # committed literals and warns "CFBundleVersion of an app extension must match its
  # containing parent app". Keeping the committed plist in lockstep kills the warning
  # and removes the dependency on Tauri's in-build rewrite.
  local file="$1"
  local version="$2"
  if [ ! -f "$file" ]; then
    echo "  skip (no Info.plist): $file" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  awk -v ver="$version" '
    /<key>CFBundleShortVersionString<\/key>/ { print; getline; sub(/<string>[^<]*<\/string>/, "<string>" ver "</string>"); print; next }
    /<key>CFBundleVersion<\/key>/ { print; getline; sub(/<string>[^<]*<\/string>/, "<string>" ver "</string>"); print; next }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "  Info.plist (app) $file → $version"
}

cargo_package_name() {
  # First `name = "..."` in a manifest is the [package] name (the file starts with
  # [package]); dependency tables come later.
  local file="$1"
  sed -n 's/^name = "\([^"]*\)".*/\1/p' "$file" | head -n 1
}

bump_cargo_lock_version() {
  # Cargo.lock pins the version of every LOCAL crate too, and a lock does not live
  # next to the crate it pins: mls-core is pinned in src-tauri's lock, shared-rust in
  # chat-gateway's. Left alone, those entries lag a release behind until some unrelated
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
    "$ROOT/libs/shared-rust/Cargo.toml"
  )
  local cargo

  shopt -s nullglob
  for cargo in "$ROOT"/apps/*/Cargo.toml; do
    files+=("$cargo")
  done
  shopt -u nullglob

  printf '%s\n' "${files[@]}" | LC_ALL=C sort -u
}

VERSION="${1:-}"
[ -n "$VERSION" ] || usage
VERSION="$(normalize_version "$VERSION")"

echo "Bumping Canari app version to ${VERSION}"

while IFS= read -r f; do
  [ -f "$f" ] || { echo "Missing: $f" >&2; exit 1; }
  bump_package_json "$f" "$VERSION"
done < <(discover_package_json_files)

TAURI_CONF="$ROOT/frontend/src-tauri/tauri.conf.json"
[ -f "$TAURI_CONF" ] || { echo "Missing: $TAURI_CONF" >&2; exit 1; }
bump_tauri_conf "$TAURI_CONF" "$VERSION"

bump_ios_nse_pbxproj "$ROOT/frontend/src-tauri/gen/apple/canari.xcodeproj/project.pbxproj" "$VERSION"

bump_ios_app_infoplist "$ROOT/frontend/src-tauri/gen/apple/canari_iOS/Info.plist" "$VERSION"

LOCAL_CRATES=" "
while IFS= read -r f; do
  [ -f "$f" ] || { echo "Missing: $f" >&2; exit 1; }
  bump_cargo_package_version "$f" "$VERSION"
  LOCAL_CRATES="${LOCAL_CRATES}$(cargo_package_name "$f") "
done < <(discover_cargo_files)

# Every lock sits next to a manifest we just bumped; a crate with no lock of its own
# (mls-core, shared-rust) is still patched inside its consumer's, via LOCAL_CRATES.
while IFS= read -r f; do
  bump_cargo_lock_version "$(dirname "$f")/Cargo.lock" "$VERSION" "$LOCAL_CRATES"
done < <(discover_cargo_files)

echo "Done."
