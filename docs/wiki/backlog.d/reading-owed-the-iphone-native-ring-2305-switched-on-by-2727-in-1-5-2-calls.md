## Reading owed - the iPhone native ring (#2305, switched on by #2727 in `1.5.2`: `CALLS_NATIVE_RING_COMPILED`, `kCanariCallsEnabled` and...

target: 1.7.0

**What is built:** the iPhone native ring (#2305, switched on by #2727 in `1.5.2`: `CALLS_NATIVE_RING_COMPILED`, `kCanariCallsEnabled` and the `voip` mode all on; [calls](../frontend/modules/calls.md#the-native-ring-on-the-iphone---pushkit-and-callkit-wp-c6-owner-2026-10-22))

**The reading that closes it:** the K6, K7, K8 and K8b readings of that page on the iPhone 12

**Triage 2026-11-14 - MERGED with the CALL-OS-BANNER entry** (one FOREGROUND ring on the iPhone: no "Appel entrant" OS banner over the in-app ring; the web's local notification is deferred while the page is visible, [calls](../frontend/modules/calls.md#the-bar-is-never-under-a-layer-call-bar-covered-2026-10-19); read the `[NOTIF]` line first, and if a banner still shows the two candidates are the notification plugin's `UNUserNotificationCenter` delegate (slot taken back for Canari at launch since 2026-11-01, `CanariNotificationDelegate` answers `UNNotificationPresentationOptionNone`) and the server's ring push reaching a device whose socket is live and foreground, a server question). **Left, iPhone only, about 25 min with a web seat as the caller: K6, K7, K8, K8b of that page, and one foreground ring.**
