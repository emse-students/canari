## P2 - iOS builds need the iOS 27 SDK before April 2027 (Apple's ITMS-90725 on build 100700011)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**What Apple said.** The upload of build `100700011` (`1.7.0-alpha.11`) was accepted with the
warning ITMS-90725: it was built with the iOS 26.2 SDK, and from April 2027 App Store Connect
accepts only uploads built with the iOS 27 SDK (Xcode 27 or later). Nothing is refused today.

**Where the 26 pin lived.** Two jobs ran on `macos-15` and REQUIRED Xcode 26 through
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

**What is built (pull request `ci/ios-27-sdk`, #3813).** Both jobs run on
`runs-on: xcode-27` and REQUIRE `xcode-version: '^27.0'` (the setup action still pinned by SHA),
the comments rewritten with both reasons (ITMS-90725, Liquid Glass); `ios-compile-job.test.mjs`
now asserts the pull-request compile names the SAME runner and the SAME pin as `ios.yml`
([cicd](../cicd.md#the-ios-toolchain-is-pinned-xcode-27-since-171)). The pull request's own
`compile-ios-app` run is the compile proof on the iOS 27 SDK.

**The native code, read for the iOS 27 SDK on 2026-11-18.** Deployment target `16.0` everywhere in
the pbxproj and `SWIFT_VERSION = 5.0`: neither raised, nothing requires it. The app already runs the
scene lifecycle Apple announced as mandatory after iOS 26 (tao's `TaoSceneDelegate`, hooked in
`canari_ios.mm`), so that requirement is met. No `keyWindow`, `UIScreen.main`, `statusBarFrame`,
`UNNotificationPresentationOptionAlert` or `kSecUseOperationPrompt` use; the one deprecated call,
`applicationIconBadgeNumber` in `canari_push.mm`, sits in the unreachable pre-16 branch of an
`@available(iOS 16.0, *)` and does not warn at a 16.0 target. No target treats warnings as errors.

**Closes with:** on the first `1.7.1` pre-release, read on the iPhone 12 from TestFlight - the install
itself, then the surfaces the new SDK may change (the glass tab bar; the notification service
extension, a push decrypted with the app killed; CallKit, a ring and an answer; the share extension,
a photo shared into a conversation), then one concrete action per Swift plugin, because llvm-objcopy
now rewrites every plugin's object (cicd.md, the Xcode 27 `@_cdecl` break):

- **biometric** - the app unlocked by Face ID;
- **customtabs** - a sign-in that opens the identity provider in the in-app browser and returns;
- **dialog** - the native file picker shown to attach a file, and the save sheet for a downloaded file;
- **gallery** - a received photo saved to the Photos library;
- **keystore** - the MLS key unlocked by PIN, and by the device key on a relaunch;
- **notification** - a notification received with the app in the background, and its tap opening the conversation;
- **opener** - an ecosystem site (the Portail, MiGallery) opened externally in Safari;
- **system_components** - the native tab bar switching places, and its unread dot shown.

Then that pre-release's App Store Connect upload carrying no ITMS-90725.

**Why `1.7.1` and not `1.8.0`** (lead decision, 2026-11-18, reversible): the signed path (keychain,
archive, export) is proven on `xcode-27` by the dispatched `ios.yml` run 44278923984, so the move
needs no version of its own - its readings ride the first `1.7.1` pre-release. Charter: principle 8
(durability).
