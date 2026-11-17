## Reading owed - the iPhone's one seed mirror keeps the extension's seeds through a foreground (2026-11-17)

target: 1.7.0

**What is built:** the P1 "blind salon banners, the failing branch is unnamed" is answered and fixed.
Production (2026-11-16, read-only) showed a salon session's seed HELD by an iPhone's notification
extension at 13:08:08 and ABSENT at 13:08:20, the app having come to the foreground in between:
every activation copied the app's own `graine_seeds.json` over the App Group's, erasing what the
extension had stored, and the frame on the next push no longer opened because the foreground had
just applied it. iOS now holds ONE mirror, the App Group's, written by the foreground and the
extension under one lock; the older build's app copy is folded in once
([channel-encryption section 27](../protocols/channel-encryption.md#27-the-iphone-held-two-seed-mirrors-and-the-one-without-the-extensions-seeds-won---fixed-2026-11-17)).
Proven by host tests (`push.rs` `graine_mirror_tests`, `iosMlsMirror.test.ts`); the Objective-C and
the iOS branch of `seed_mirror_home` are compiled only by the release's iOS build.

**The reading that closes it, on the iPhone 12** (`tools/ios-device`, `pymobiledevice3 syslog live`):
on a pre-release carrying it, with the app killed, make a member join the salon's community from
another account (a rotation), then send a salon message from a third account: the banner shows the
text. Open the app on another screen and leave it in the FOREGROUND; send the next message of the
same session: the extension's log reads the mirror (no `openSeedFrame: ... frame did not yield key
material`), and the server logs no `[PUSH_BLIND]` for the iPhone. Then once more after sending the
app to the background. The first launch of the new build logs `[GRAINE_MIRROR] the app's former
seed mirror folded into the App Group` once, and never again.

**And on production, a day after the stable carrying it:** `[PUSH_BLIND]` grouped by `platform`:
the iOS `missing=seed refused=none` lines go to zero from builds carrying it (the line names no
version, so read it with the stable's adoption). An Android line (`held=true`, one on 2026-11-14)
has a different cause, since Android always had one file: read its phone's in-app log
(`[NATIVE_PUSH] ... openSeedFrame`) before building anything for it
([its entry](p2-android-blind-salon-banner-held-true.md)).
