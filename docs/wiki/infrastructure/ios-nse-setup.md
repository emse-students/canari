# iOS Notification Service Extension - Mac wiring checklist

The Notification Service Extension (NSE) decrypts push notifications on iOS so the
user sees the real message text instead of the generic "Nouveau message" fallback
(WP-iOS-6), with per-conversation grouping, a sender subtitle and an avatar
attachment (WP-iOS-7).

**All the code ships in the repo.** What is left below can only be done on a Mac /
in Xcode / in the Apple Developer portal - the code side needs no further edits.

> **Why this is a manual Xcode step and not a config generator.** The authoritative
> Xcode project is the hand-maintained `canari.xcodeproj/project.pbxproj` (edited in
> Xcode, using Pods/SPM - see `frontend/src-tauri/gen/apple/README.md`). The CI builds
> that `.xcodeproj` directly and **never runs xcodegen**, and `project.yml` is not the
> build source of truth (it does not even reflect the Firebase/SPM/signing wiring that
> makes the app compile). So the NSE target must be **added by hand in Xcode**, the same
> way every other Canari-specific addition to the project was made. Do not try to
> regenerate the project from `project.yml`: it would wipe the working Firebase/SPM
> setup.

## What is already in the repo

| Piece | Path |
| --- | --- |
| Extension source (decrypt + rewrite) | `frontend/src-tauri/gen/apple/canari_NSE/NotificationService.swift` |
| C FFI header for the Rust decrypt functions | `frontend/src-tauri/gen/apple/canari_NSE/canari_mls_ffi.h` |
| Swift bridging header | `frontend/src-tauri/gen/apple/canari_NSE/canari_NSE-Bridging-Header.h` |
| Extension Info.plist (`NSExtensionPointIdentifier`) | `frontend/src-tauri/gen/apple/canari_NSE/Info.plist` |
| Extension entitlements (App Group) | `frontend/src-tauri/gen/apple/canari_NSE/canari_NSE.entitlements` |
| App entitlements (App Group added) | `frontend/src-tauri/gen/apple/canari_iOS/canari_iOS.entitlements` |
| App-side App Group mirror | `canari_push.mm` `CanariMirrorPushStateToAppGroup` + calls in `canari_ios.mm` |
| Backend: iOS `apns` block for channel/social pushes | `apps/chat-delivery-service/src/services/push-payload.ts` `buildInternalApnsRequest` (used by `sendPushToUser`) |

The MLS DM/group push path already carries `mutable-content: 1` (chat-delivery
`buildApnsRequest`), so the NSE is reachable for those with **no backend change**.
The channel/social path was data-only (never triggered the NSE on iOS); the
`buildInternalApnsRequest` change fixes that.

## How it works

1. The app writes `mls.bin`, `push_context.json`, `channel_keys.json` and the push
   secret into the shared App Group container `group.fr.emse.canari` on every
   foreground/background transition (`CanariMirrorPushStateToAppGroup`).
2. A push with `mutable-content: 1` launches the NSE in its own process.
3. The NSE reads those mirrored inputs, calls the same Rust decrypt FFI the app uses
   (`canari_native_decrypt_message` / `_with_commits` / `_decrypt_channel_message`,
   linked from `libapp.a`), and rewrites `bestAttemptContent`.
4. Decryption is read-only: the NSE never writes `mls.bin`. State stays authoritative
   in the app's Application Support directory.

## Apple Developer portal steps

> Prerequisite: a Mac with Xcode and the Apple Developer account (see
> `ios-ci-cd-setup.md`).

1. **Register the App Group on the App IDs.** In
   [developer.apple.com](https://developer.apple.com) -> Certificates, Identifiers &
   Profiles -> Identifiers:
   - Create an App Group `group.fr.emse.canari` (Identifiers -> App Groups) if it does
     not exist.
   - Enable the **App Groups** capability on the app's App ID `fr.emse.canari` and add
     `group.fr.emse.canari`.
   - Create a new App ID `fr.emse.canari.notifications` for the extension, enable **App
     Groups**, add the same group.

2. **Regenerate provisioning profiles.** Adding the App Group invalidates the existing
   profiles. Regenerate a profile for BOTH `fr.emse.canari` and
   `fr.emse.canari.notifications` (development + distribution as needed). Update the
   `APPLE_PROVISIONING_PROFILE` CI secret(s) once WP-iOS-11 CD is enabled - the NSE needs
   its own profile in addition to the app's.

## Xcode steps - add the NSE target to `canari.xcodeproj` (by hand)

Open `canari.xcworkspace` (not `.xcodeproj` - the workspace, because Firebase/Pods are
installed) from `frontend/src-tauri/gen/apple`.

1. **Create the extension target.** File -> New -> Target -> **Notification Service
   Extension**. Product name `CanariNotifications`, bundle id
   `fr.emse.canari.notifications`, language Swift. Let Xcode embed it into `canari_iOS`
   when it asks. Delete the stub `NotificationService.swift`/`Info.plist` Xcode creates.

2. **Point the target at the repo's source files** (do not keep Xcode's generated
   copies). Add to the `CanariNotifications` target's *Compile Sources* / *Copy Bundle
   Resources*:
   - `canari_NSE/NotificationService.swift` (Compile Sources)
   - `canari_NSE/Info.plist` as the target's Info.plist (Build Settings ->
     *Info.plist File* = `canari_NSE/Info.plist`)
   - `canari_NSE/canari_NSE.entitlements` as *Code Signing Entitlements*
   Set Build Settings:
   - *Objective-C Bridging Header* = `canari_NSE/canari_NSE-Bridging-Header.h`
   - *Product Bundle Identifier* = `fr.emse.canari.notifications`
   - `ENABLE_BITCODE = NO`, `SWIFT_VERSION = 5.0`
   - `LIBRARY_SEARCH_PATHS` includes `$(PROJECT_DIR)/Externals/$(CURRENT_ARCH)/$(CONFIGURATION)`
     (arch-scoped, mirroring the app target) so the linker finds `libapp.a`.

3. **Link the Rust static lib.** In the extension target's *Frameworks and Libraries*
   add `libapp.a` (the app's existing "Build Rust Code" phase produces it under
   `Externals/<arch>/<config>`), plus `Security.framework` and
   `UserNotifications.framework`. The linker dead-strips everything the extension does
   not call.

4. **Signing & Capabilities (both targets).** On BOTH `canari_iOS` and
   `CanariNotifications`, add the **App Groups** capability and tick
   `group.fr.emse.canari`. Assign each target the matching provisioning profile from the
   portal step above.

5. **Confirm the embed.** Under `canari_iOS` -> *Frameworks, Libraries, and Embedded
   Content*, `CanariNotifications.appex` must appear as *Embed Without Signing* /
   *Embed & Sign* (an embedded app extension). Build the `canari_iOS` scheme.

> If the linker rejects `libapp.a` symbols in the extension (extension-unavailable
> symbols, or excessive binary size), split a dedicated `canari-mls-ffi` staticlib crate
> exposing only the decrypt FFI and link that instead (documented fallback; not needed
> for a first build).

Per-locale permission strings are still FR-only (tracked as WP-iOS-10) - unrelated to
the NSE.

## On-device verification ([device])

- Send yourself a DM from another account while the iPhone app is backgrounded: the
  banner must show the decrypted text, not "Nouveau message".
- Group chat: the banner title is the group name with the sender as the subtitle, and
  notifications for the same conversation stack together.
- Post a message in a community channel: the banner shows the decrypted channel text
  under a `#channel` title (requires the channel to have been opened once so
  `channel_keys.json` is populated and mirrored).
- Force-quit caveat: iOS never launches the NSE for a force-quit app until the user
  reopens it - same structural limit documented for background execution
  (`chat-delivery.md`).
