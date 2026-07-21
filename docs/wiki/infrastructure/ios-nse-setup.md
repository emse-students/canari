# iOS Notification Service Extension - Mac wiring checklist

The Notification Service Extension (NSE) decrypts push notifications on iOS so the
user sees the real message text instead of the generic "Nouveau message" fallback
(WP-iOS-6), with per-conversation grouping, a sender subtitle and an avatar
attachment (WP-iOS-7).

**All the code ships in the repo.** What is left below can only be done on a Mac /
in the Apple Developer portal - the code side needs no further edits.

## What is already in the repo

| Piece | Path |
| --- | --- |
| Extension source (decrypt + rewrite) | `frontend/src-tauri/gen/apple/canari_NSE/NotificationService.swift` |
| C FFI header for the Rust decrypt functions | `frontend/src-tauri/gen/apple/canari_NSE/canari_mls_ffi.h` |
| Swift bridging header | `frontend/src-tauri/gen/apple/canari_NSE/canari_NSE-Bridging-Header.h` |
| Extension Info.plist (`NSExtensionPointIdentifier`) | `frontend/src-tauri/gen/apple/canari_NSE/Info.plist` |
| Extension entitlements (App Group) | `frontend/src-tauri/gen/apple/canari_NSE/canari_NSE.entitlements` |
| XcodeGen target definition | `frontend/src-tauri/gen/apple/project.yml` (`canari_NSE` target) |
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

## Mac / Apple Developer portal steps (the only remaining work)

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

3. **Generate the Xcode project and verify the target.** From `frontend`:
   ```sh
   bun tauri ios build   # or: cd src-tauri/gen/apple && xcodegen generate
   ```
   XcodeGen creates the `canari_NSE` app-extension target from `project.yml` and embeds
   it in the app. Open `canari.xcodeproj` and confirm:
   - `canari_NSE` appears under the app's "Frameworks, Libraries, and Embedded Content"
     as an embedded app extension.
   - The extension target's *Signing & Capabilities* shows the App Group
     `group.fr.emse.canari` (ticked) and a valid provisioning profile.
   - Build Settings -> "Objective-C Bridging Header" points at
     `canari_NSE/canari_NSE-Bridging-Header.h`.

4. **Confirm `libapp.a` links into the extension.** The `canari_NSE` target declares a
   `libapp.a` dependency; the app's existing "Build Rust Code" phase produces it. If the
   linker complains about missing `canari_native_*` symbols, ensure the extension's
   `LIBRARY_SEARCH_PATHS` resolve to `Externals/<arch>/<config>` (already set in
   `project.yml`). If extension binary size or extension-unavailable-symbol errors appear,
   split a dedicated `canari-mls-ffi` staticlib crate exposing only the decrypt FFI and
   link that instead (documented fallback; not needed for a first build).

5. **Per-locale permission strings** are still FR-only (tracked as WP-iOS-10) - unrelated
   to the NSE.

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
