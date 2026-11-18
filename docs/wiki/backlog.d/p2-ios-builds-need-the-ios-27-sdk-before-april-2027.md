## P2 - iOS builds need the iOS 27 SDK before April 2027 (Apple's ITMS-90725 on build 100700011)

target: 1.8.0

**What Apple said.** The upload of build `100700011` (`1.7.0-alpha.11`) was accepted with the
warning ITMS-90725: it was built with the iOS 26.2 SDK, and from April 2027 App Store Connect
accepts only uploads built with the iOS 27 SDK (Xcode 27 or later). Nothing is refused today.

**Where the 26 pin lives.** Two jobs run on `macos-15` and REQUIRE Xcode 26 through
`maxim-lobanov/setup-xcode` with `xcode-version: '^26.0'`: `build-ios` in
`.github/workflows/ios.yml` (the `runs-on` line and the "Select Xcode 26" step, whose comment
explains why the pin is REQUIRED, not merely allowed: an older toolchain silently builds the classic
tab bar without Liquid Glass) and `compile-ios-app` in `.github/workflows/ci.yml` (same pin, same
reason).

**What the runner offers, verified 2026-11-18** in `actions/runner-images` (read with `gh api`):
the repository README (last changed at `2cdd82f39871`, 2026-11-03) lists an "Xcode 27" image,
arm64, under the labels **`xcode-27` or `xcode-27-xlarge`**, still badged **preview** and linked to
the announcement "Xcode 27 is now available as a public preview" (runner-images issue 14404) - not
yet the generally available state a later GitHub post announced for 2026-10-15. Its software list,
`images/macos/xcode-27-arm64-Readme.md` (last changed at `c0f5743aeac9`, 2026-11-09): macOS 27.0.1,
image version `20261104.0337.1`, Xcode 27.0, 27.1 (the default) and 27.2, and the iOS SDKs 27.0,
27.1 and 27.2. The same README announces that the default OpenSSL moves from 3 to 4 on that image.

**The work.**

1. Both jobs to the standard `xcode-27` label (not `-xlarge`), and the pin to `xcode-version:
   '^27.0'`, REQUIRED the same way (the run fails when no 27.x is on the image); the comments that
   name Xcode 26 rewritten with the reason kept.
2. The Liquid Glass and extension assertions of `ios.yml` re-run on the new toolchain (the tab bar's
   `#if compiler(>=6.2)` glass branch, the push and share extensions bundled and signed).
3. A TestFlight build read on the iPhone 12: the glass tab bar, the notification service extension
   (a push decrypted with the app killed), CallKit (a ring and an answer), the share extension.

**Closes with:** an App Store Connect upload that carries no ITMS-90725, and that iPhone 12 reading.

**Why not `1.7.1`:** a new SDK can change UI defaults (bar appearance, safe areas, sheet behaviour),
so it ships in a version with room for a full phone pass, not in a fix release. Charter: principle 8
(durability).
