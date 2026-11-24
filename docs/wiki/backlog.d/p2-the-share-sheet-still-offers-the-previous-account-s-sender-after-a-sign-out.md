## P2 - the iOS share sheet still offers the previous account's sender as a person after a sign-out (2026-11-24)

target: 1.8.0

**Seen on the iPhone 12, `1.8.0-alpha.6`** ([sitting](../device-verification.md#the-readings-of-2026-11-24-180-alpha6-iphone-12-the-dm-thread-again-the-composer-the-ios-27-sdk-build-the-broadcasters-column-the-voice-note-the-sign-out-row)), reading row 6 of [iPhone message banners as communication notifications](ios-communication-notifications.md). Not fixed here.

**What was seen.** `gamma` had received DMs from `delta` all day, so the notification extension had donated `delta` as a sender. `gamma` signed out from the dashboard: the app logged the sign-out (`logout 200`, `[SHARE] fenced at epoch 2 (signed out)`, `[Push] sign-out ended this device's push registration (ios)`, `signout: MiConnect end-session browser ended (cancelled)`). From Photos, Share on a photo: the share sheet still showed a person suggestion "Canari Test Delta" with the Canari badge, **90 s after the sign-out and again about 3 min after it**. The rule of this feature (the donations "leave with the account", [mobile](../frontend/mobile.md#communication-notifications-owner-2026-11-21)) says the next account's share sheet offers none of the previous account's senders.

**What is NOT known.** Whether `eraseAccountShortcuts` ran at all: its success line, `conversation shortcuts erased, 0 counted`, is `Log.d` in `shareTargetsNative.ts` and the exported in-app log records no DEBUG line, so a silent success and a silent skip look the same (the same lesson as #4023's fall line, which had to move to INFO). The syslog window around 09:21:56 carries no donation-delete line of the app either.

**Hypotheses, in order.** (1) The erase never ran or ran for an empty group: the ticket/owed-mark logic skipped it for this sign-out. (2) It ran, but the donations that feed the share sheet's people row are not in the group it deletes (the extension donates with one group identifier, the share suggestions with another), or the system's suggestion cache outlives the deletion for minutes. The first step is a line at INFO in the erase (`erased n group(s)` / `skipped: <reason>`), then the same gesture again.

**To close it.** Sign `gamma` out after a day of DMs: the share sheet offers no person from the previous account within a few seconds, and the log carries the erase at INFO.
