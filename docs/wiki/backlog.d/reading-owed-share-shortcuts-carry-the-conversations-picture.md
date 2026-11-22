## Reading owed - the launcher's long-press conversations and the share sheet show each conversation's picture (Android, owner, 2026-11-20)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Built: every share-target shortcut is published with its picture - the cached photo, group image or
community logo, else the initials disc - and the missing pictures are fetched afterwards and pushed
again under the same id ([sharing](../frontend/sharing.md), "the picture of a shortcut"). The
notification's conversation shortcut uses the same adaptive icon helper. The Kotlin is compiled by
CI's APK build only: nothing was run on a phone.

The reading that closes it, on the Mi 9T with a signed-in account (after one departure from the app,
so the page publishes): (1) long-press the Canari icon: each listed conversation has a round picture,
no empty white circle - a DM its peer's photo, a group its image, a salon its community's logo, a
conversation with none the coloured initials disc; (2) a conversation whose photo was never cached
shows the initials first and the photo after the next look at the menu (logcat `ShareTargets`:
`publish: N picture(s) to fetch after the publish`, then `upgradeIcons: N of N picture(s) set`);
(3) the face is not cropped inside the circle, and the share sheet's direct row shows the same
pictures; (4) a message notification's conversation header shows the same picture as the menu;
(5) sign out: the menu lists no Canari conversation afterwards, even when a fetch was in flight.

**2026-11-20, [S18](../device-verification.md#the-readings-of-2026-11-20-s18-172-alpha3-notice-previews-launcher-shortcuts-the-capture-line-live-screens-and-the-backup-domains) (`1.7.2-alpha.3`, Mi 9T): the launcher half PASS, the share sheet NOT TAKEN.** The published shortcuts carry their pictures (`bitmapPath` set). **Left:** the share sheet's direct row, the not-cropped face, the cached-later upgrade and the sign-out clearing (steps 2 to 5).

**2026-11-21 (`1.7.3-alpha.1`, Mi 9T, sitting r173a2): PARTIAL.** The launcher long-press showed 4
conversations, each with an initials disc and no empty white circle; `dumpsys shortcut` listed 5
share-target shortcuts, each with a `bitmapPath`; the log read `ShareTargets: publish: 5 of 5 present,
0 removed`. **Still owed:** a real peer photo or group image (step 1 read only initials discs), the
share sheet's direct row, the upgrade when the picture is cached later, the face not cropped, the
picture in the notification header, and the clearing on sign-out.

**Mi 9T sitting, 1.7.3-alpha.5 (2026-11-22): PARTIAL, entry stays. Launcher long-press shows the shortcuts with initials discs and dumpsys shortcut shows a bitmap on every Canari shortcut; the share-sheet direct row, the uncached-photo upgrade and the sign-out clearing are UNREAD (the chooser gave a stacked dialog with no direct row).**

**Mi 9T sitting, `1.7.3-alpha.6` (2026-11-22): step 3 PASS, steps 2, 4 and 5 NOT readable on the bench, each with its replacement.** The REAL chooser (an image opened in the system gallery and shared from its button; a bare `SEND` intent only shows the plain app picker with no direct row) lists three Canari conversations as direct targets, each a round picture with the Canari badge and no empty circle; the test accounts have no uploaded photo, so each is the initials disc, and "the face is not cropped" is not read. `ShareTargets: publish: 5 of 5 present, 0 removed, 0 left to remove`. **Replacements:** (2) and (4), a `ShareTargetsUpgradeTest.kt` beside the other Android JVM tests, on the pure part of `ShareTargets.kt`: a publish of three shortcuts, one with a picture not in the cache, carries the initials icon for it and reports `1 picture to fetch`; the fetched bytes then upgrade the SAME shortcut id and log `upgradeIcons: 1 of 1 picture(s) set`; the notification's shortcut and the menu's come out of the one adaptive-icon helper with equal bytes. (5), the same file: `clear()` followed by a late upgrade result leaves the list empty and re-publishes nothing (the TypeScript half, `shareTargets.test.ts`, already covers the sign-out and the in-flight publish). Signing the shared bench account out to read it was refused: it would drop that device's state under the other sittings. The entry stays.

**Closed by tests (2026-11-22).** Steps 2, 4 and 5 are `ShareTargetsUpgradeTest.kt`, over the loop `ShareTargets.upgradeIcons` now takes from
`pure/ShareTargetsUpgrade.kt`: one pending picture pushes the SAME shortcut id and the pass ends `upgradeIcons: 1 of 1 picture(s) set`
(step 2); the menu's and the notification's circle come out of the one `ShortcutIcons.adaptive` helper, asserted on the source because a
`Bitmap` cannot be built on the JVM (step 4); a `clear()` or a later publish ends the pass and nothing is pushed back (step 5; the
TypeScript half stays `shareTargets.test.ts`). Step 3 (the share sheet's direct row) is PASS. **What stays open, and only this:** step 1's
real photo and step 3's "the face is not cropped inside the circle" - the bench accounts have no uploaded photo, and no test draws a
bitmap. A reading with a peer who has a profile photo (Mi 9T or Pixel 6a) closes it.

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** Nothing is left that a test can take. Left, Mi 9T: give a test account an uploaded profile photo on dev (a logged dev write), then read the launcher menu and the share sheet for a real photo, the face not cropped inside the circle.
