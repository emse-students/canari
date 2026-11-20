## Reading owed - the launcher's long-press conversations and the share sheet show each conversation's picture (Android, owner, 2026-11-20)

target: 1.7.2

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
