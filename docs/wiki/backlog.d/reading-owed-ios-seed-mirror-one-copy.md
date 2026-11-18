## Reading owed - the iPhone's one seed mirror keeps the extension's seeds through a foreground (2026-11-17)

target: 1.7.0

_2026-11-18, sitting [S7](../device-verification.md#the-web-and-phone-readings-of-2026-11-18-s7-170-alpha12-the-last-sitting-before-the-stable): **what is left is read in production a day after the stable (the `[PUSH_BLIND]` count by platform); it does NOT block cutting the stable.** The iPhone half was read on `alpha.8`; the fold it named is replaced by a delete since the `1.7.0` floor, and neither line has an instrument on a store build (below)._

**What is built:** the P1 "blind salon banners, the failing branch is unnamed" is answered and fixed.
Production (2026-11-16, read-only) showed a salon session's seed HELD by an iPhone's notification
extension at 13:08:08 and ABSENT at 13:08:20, the app having come to the foreground in between:
every activation copied the app's own `graine_seeds.json` over the App Group's, erasing what the
extension had stored, and the frame on the next push no longer opened because the foreground had
just applied it. iOS now holds ONE mirror, the App Group's, written by the foreground and the
extension under one lock; the older build's app copy was folded in once, and is deleted unread since
the `1.7.0` floor
([channel-encryption section 27](../protocols/channel-encryption.md#27-the-iphone-held-two-seed-mirrors-and-the-one-without-the-extensions-seeds-won---fixed-2026-11-17)).
Proven by host tests (`push.rs` `graine_mirror_tests`, `iosMlsMirror.test.ts`); the Objective-C and
the iOS branch of `seed_mirror_home` are compiled only by the release's iOS build.

**The reading that closes it, on the iPhone 12** (`tools/ios-device`, `pymobiledevice3 syslog live`):
on a pre-release carrying it, with the app killed, make a member join the salon's community from
another account (a rotation), then send a salon message from a third account: the banner shows the
text. Open the app on another screen and leave it in the FOREGROUND; send the next message of the
same session: the extension's log reads the mirror (no `openSeedFrame: ... frame did not yield key
material`), and the server logs no `[PUSH_BLIND]` for the iPhone. Then once more after sending the
app to the background. (The fold line this named - `[GRAINE_MIRROR] ... folded into the App Group` - is gone with the fold,
retired by the `1.7.0` floor: the old copy is now deleted unread,
`[GRAINE_MIRROR] the app's former seed mirror deleted`, which a store build's log cannot show either.)

**And on production, a day after the stable carrying it:** `[PUSH_BLIND]` grouped by `platform`:
the iOS `missing=seed refused=none` lines go to zero from builds carrying it (the line names no
version, so read it with the stable's adoption). An Android line (`held=true`, one on 2026-11-14)
has a different cause, since Android always had one file: read its phone's in-app log
(`[NATIVE_PUSH] ... openSeedFrame`) before building anything for it
([its entry](p2-android-blind-salon-banner-held-true.md)).

**iPhone 12, 2026-11-17 (`1.7.0-alpha.8`, [readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)): the salon half `PASS`, the fold line NOT READ.** App killed, `delta` then `alpha` joined the community (each join was followed by a new session; after `delta`'s the sender kept the old one for two messages, about three minutes), a third account's salon messages: every banner showed the text, the extension logged `seed source=mirror ... outcome=decrypted` for each, including the first message of the new session with the app killed, then with the app in the FOREGROUND on another screen and after it went to the background; `[PUSH_BLIND]` absent from chat-delivery over the 15 minutes. The app's former `graine_seeds.json` is gone from its Application Support (only `graine_seeds.lock` remains, read over `house_arrest`). **Not read:** the `[GRAINE_MIRROR] ... folded into the App Group` line - a Rust `log::` line reaches neither the device syslog nor the in-app log ring on a store build, so the "once, and never again" half has no instrument; reading it needs the line routed where a store build's log can be pulled.
