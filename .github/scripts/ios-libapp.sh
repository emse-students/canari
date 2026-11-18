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
# Needs: rustup, macOS with Xcode 27. `frontend/build` must already exist (`generate_context!()` embeds it).
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
# XCODE 27 EMITS A SWIFT `@_cdecl` EXPORT AS A LOCAL SYMBOL, so every Swift plugin's
# `init_plugin_*` is invisible to the linker ("Undefined symbols ... _init_plugin_customtabs", the
# first compile on the `xcode-27` runner). swift-rs promotes them back to global with rustup's
# `llvm-objcopy` (Apple ships none) and, when the tool is missing, only WARNS and links nothing -
# so the component is installed into the toolchain cargo uses, not left to chance
# (docs/wiki/cicd.md#the-ios-toolchain-is-pinned-xcode-27-since-171).
rustup component add llvm-tools
cargo build --lib --release --target aarch64-apple-ios --features "$features"

lib="$(find target/aarch64-apple-ios/release -maxdepth 1 -name 'libmines_app_lib.a' | sed -n 1p)"
if [ -z "$lib" ]; then
  echo "::error::libmines_app_lib.a not produced by cargo"
  exit 1
fi
dest="gen/apple/Externals/arm64/release"
mkdir -p "$dest"
cp "$lib" "$dest/libapp.a"

# EVERY SWIFT PLUGIN'S ENTRY POINT IS AN EXTERNAL SYMBOL, checked HERE, by name, rather than met as
# "Undefined symbols" at the Xcode link. Xcode 27 emits `@_cdecl` exports as LOCAL symbols and
# swift-rs re-exports them with llvm-objcopy (above); a plugin it skipped would otherwise surface
# twenty minutes later, without saying which mechanism failed. Every `_init_plugin_*` the Rust
# objects reference (`U`) must be defined external (`T`) in the same archive.
#
# RUSTUP'S `llvm-nm`, NOT XCODE'S `nm`: the archive carries rustc's LLVM bitcode, which Apple's
# older LLVM cannot read ("Unknown attribute kind (105)", one error per member, and a non-zero
# exit). The `llvm-tools` component installed above ships the reader of the same LLVM as rustc.
host="$(rustc -vV | awk '/^host:/ {print $2}')"
llvm_nm="$(rustc --print sysroot)/lib/rustlib/$host/bin/llvm-nm"
if [ ! -x "$llvm_nm" ]; then
  echo "::error::$llvm_nm is missing - the llvm-tools component did not install"
  exit 1
fi
symbols="$("$llvm_nm" -g "$dest/libapp.a")"
wanted="$(echo "$symbols" | awk '$1 == "U" && $2 ~ /^_init_plugin_/ {print $2}' | sort -u)"
defined="$(echo "$symbols" | awk '$2 == "T" && $3 ~ /^_init_plugin_/ {print $3}' | sort -u)"
if [ -z "$wanted" ]; then
  echo "::error::libapp.a references no _init_plugin_* symbol - this check would pass on nothing"
  exit 1
fi
missing="$(comm -23 <(echo "$wanted") <(echo "$defined"))"
if [ -n "$missing" ]; then
  echo "::error::libapp.a does not export these Swift plugin entry points (local or absent): $(echo "$missing" | tr '\n' ' ')"
  exit 1
fi
echo "Swift plugin entry points exported: $(echo "$wanted" | tr '\n' ' ')"
echo "libapp.a staged at $dest ($(du -h "$dest/libapp.a" | cut -f1))"
