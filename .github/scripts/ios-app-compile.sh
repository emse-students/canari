#!/usr/bin/env bash
#
# COMPILE THE iOS APP (the app, the notification extension, the share extension and every Swift
# plugin) ON A PULL REQUEST, UNSIGNED, AND PROVE THE EXTENSIONS CAME OUT.
#
# WHAT THIS EXISTS FOR. Nothing on the Windows workstation compiles Swift or Objective-C, and
# `ci.yml` ran no iOS job, so a type error, a missing `import` or an unavailable API in
# `gen/apple` or a plugin first failed at a release cut, after the merge, blocking everything
# behind it (docs/wiki/cicd.md). `swift-syntax.sh` parses; only a compile resolves types.
#
# COMPILE ONLY: no signing identity, no profile, no secret is read (a Dependabot or fork pull
# request has none), `xcodebuild build` rather than `archive`, nothing exported or uploaded.
# What a release builds beyond this (signing, export, TestFlight, the icon tint) stays in `ios.yml`.
#
# WHAT STANDS IN FOR A SECRET:
#   - `GoogleService-Info.plist` is a git-ignored secret the pbxproj lists as a bundled resource, so
#     a build without one fails on the missing input. A stub with fake values stands in; a REAL one
#     (a developer's copy, not recoverable from git) is never overwritten - the script refuses.
#   - the frontend `.env` takes placeholder origins: the bundle is compiled, never run.
#
# THE BUILD IS NOT THE ASSERTION. `ios-extensions.sh` then checks the built .app embeds exactly its
# two extensions: an extension target dropped from the scheme still builds green.
#
# Needs: macOS with Xcode 26, bun, rustup, and `bun install` + the MLS wasm + `proto:gen` done.
# Usage: bash .github/scripts/ios-app-compile.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
apple="$root/frontend/src-tauri/gen/apple"
stub_marker="canari-compile-check-stub"

echo "== 1. stand-ins for what is a secret"
plist="$apple/canari_iOS/GoogleService-Info.plist"
if [ -e "$plist" ] && ! grep -q "$stub_marker" "$plist"; then
  echo "::error::$plist exists and is not the compile stub - refusing to overwrite a real one"
  exit 1
fi
mkdir -p "$apple/canari_iOS"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>GOOGLE_APP_ID</key><string>1:000000000000:ios:0000000000000000</string>
  <key>GCM_SENDER_ID</key><string>000000000000</string>
  <key>PROJECT_ID</key><string>$stub_marker</string>
  <key>BUNDLE_ID</key><string>fr.emse.canari</string>
  <key>API_KEY</key><string>stub</string>
</dict></plist>
PLIST

env_file="$root/frontend/.env"
if [ ! -e "$env_file" ]; then
  {
    for v in FRONTEND GATEWAY DELIVERY MEDIA CALL SOCIAL CORE AUTHENTIK; do
      echo "VITE_${v}_URL=https://compile-check.invalid"
    done
    echo "VITE_AUTHENTIK_CLIENT_ID=compile-check"
  } > "$env_file"
fi

echo "== 2. the frontend bundle (embedded by the Rust crate at compile time)"
(cd "$root/frontend" && TAURI_TARGET=aarch64-apple-ios bun run build)

echo "== 3. libapp.a (the one implementation ios.yml also calls)"
bash "$root/.github/scripts/ios-libapp.sh"

echo "== 4. the Xcode project: structure, packages, unsigned build"
plutil -lint "$apple/canari.xcodeproj/project.pbxproj"
(cd "$apple" && xcodebuild -resolvePackageDependencies -project canari.xcodeproj -scheme canari_iOS)

rm -rf "$apple/assets"
mkdir -p "$apple/assets"
cp -r "$root/frontend/build/." "$apple/assets/"

derived="$(mktemp -d)"
xcodebuild build \
  -project "$apple/canari.xcodeproj" \
  -scheme canari_iOS \
  -configuration release \
  -sdk iphoneos \
  -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  DEVELOPMENT_TEAM=""

echo "== 5. the build produced the app with exactly its two extensions"
app="$(find "$derived/Build/Products" -maxdepth 2 -name '*.app' | sed -n 1p)"
if [ -z "$app" ]; then
  echo "::error::xcodebuild exited 0 but produced no .app under $derived/Build/Products"
  exit 1
fi
bash "$root/.github/scripts/ios-extensions.sh" "$app"
echo "iOS compile check passed: $(basename "$app")"
