#!/usr/bin/env bash
#
# CROSS-COMPILE THE APP CRATE FOR iOS AND STAGE IT WHERE XCODE'S LINKER LOOKS, as `libapp.a`.
#
# ONE IMPLEMENTATION, TWO CALLERS: `ios.yml` (a release, or a hand-dispatched build) and the
# `compile-ios-app` job of `ci.yml` (a pull request). It used to live inline in `ios.yml`, which a
# pull-request compile could only have reached by copying it.
#
# WHY THE SCRIPT AND NOT XCODE: the "Build Rust Code" phase of the hand-maintained pbxproj is
# disabled (it shells out to bun, which Xcode's PATH lacks) and `Externals/` is gitignored, so a
# clean checkout has no `libapp.a` and the app AND the NSE fail to link. This reproduces what
# Tauri's xcode-script does.
#
# `--features tauri/custom-protocol` is required because `tauri ios build` is bypassed: without it
# tauri-build bakes `dev=true` into the binary, which loads the webview from a Vite dev server a
# real device cannot reach (a black screen; shipped once as TestFlight v0.14.4).
#
# `IOS_EXTRA_CARGO_FEATURES` (comma-separated, optional) is the bench build's `tauri/devtools,
# bench-observables`; a store build and the pull-request compile leave it empty.
#
# Needs: rustup, macOS. `frontend/build` must already exist (`generate_context!()` embeds it).
# Usage: bash .github/scripts/ios-libapp.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root/frontend/src-tauri"

# The lowest pbxproj IPHONEOS_DEPLOYMENT_TARGET (16.0). Without it rustc/cc default the objects'
# min-iOS to the SDK version and every link pass floods "object file built for newer iOS version".
export IPHONEOS_DEPLOYMENT_TARGET="16.0"

features="tauri/custom-protocol"
if [ -n "${IOS_EXTRA_CARGO_FEATURES:-}" ]; then features="$features,$IOS_EXTRA_CARGO_FEATURES"; fi
echo "cargo features: $features"

# rust-toolchain.toml pins the compiler and lists no `targets`, so the iOS std must be added to the
# toolchain cargo actually uses.
rustup target add aarch64-apple-ios
cargo build --lib --release --target aarch64-apple-ios --features "$features"

lib="$(find target/aarch64-apple-ios/release -maxdepth 1 -name 'libmines_app_lib.a' | sed -n 1p)"
if [ -z "$lib" ]; then
  echo "::error::libmines_app_lib.a not produced by cargo"
  exit 1
fi
dest="gen/apple/Externals/arm64/release"
mkdir -p "$dest"
cp "$lib" "$dest/libapp.a"
echo "libapp.a staged at $dest ($(du -h "$dest/libapp.a" | cut -f1))"
