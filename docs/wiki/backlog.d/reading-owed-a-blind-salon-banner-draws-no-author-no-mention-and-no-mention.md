## Reading owed - a blind salon banner draws no author, no mention and no mention route, and a held mention's redraw does not sound twice

target: 1.7.0

**What is built:** a blind salon banner draws no author, no mention and no mention route, and a held mention's redraw does not sound twice (2026-10-22; Android JVM-tested and source-pinned, NOTHING native compiled or run here, the NSE XCTest not wired)

**The reading that closes it:** next pre-release, app killed, a salon mention of the reader: on the Mi 9T with the seed held back, one generic banner on `canari_messages` with the salon's initials and no "mentioned you", then the redraw with the author and the mention, ONE sound in all (`reposted silent` in logcat); the same with the blind banner swiped away before the seed (`existing=false`, still one sound); and how MIUI treats a silent group child; on the iPhone 12 the blind banner plays the message trill, not the mention one. iOS never redraws, so a blind mention stays an ordinary banner for good ([channel-encryption](../protocols/channel-encryption.md#215-the-native-readers-wp-g2-4b))

**Triage 2026-11-14 - MERGED with two entries, the same blind-banner setup on the Mi 9T (`[PUSH_BLIND] ... held=true`).** (a) **"Marquer comme lu" from a salon notification on Android** (a PushSecret call to the salon's read receipt, [mobile](../frontend/mobile.md#a-salon-mark-as-read-only-and-why-reply-is-not-offered-decided-2026-10-10-android)): one tap on the Mi 9T against dev. (b) **a BLIND salon banner offers no "Marquer comme lu"** (2026-10-14, [read-receipt-privacy](../read-receipt-privacy.md)): a salon banner posted while its seed is missing shows no action, and the same banner redrawn with its text shows it. **Left: Mi 9T only, about 25 min for all three** (hold the seed back with the seed-mirror hook, one salon mention). The iPhone half ("the blind banner plays the message trill") is DELETED: a sound cannot be observed from the bench, and iOS never redraws, so a blind mention stays an ordinary banner by construction.

**(a) "Marquer comme lu" READ on the Mi 9T, 2026-11-15 on dev (`1.6.12-alpha.2`, build 100601202, the alpha account):**
- the button was tapped on a salon mention's notification;
- logcat showed `postChannelRead: HTTP 201 channel=3b70d27c`, and the row was removed;
- the server logged `[CHANNEL_READ] advanced ... user=f7a9bb80` and `[CHANNEL_READ_PUSH] ... moved=true`.

The blind half was not staged. The bench phone runs a release build, so `run-as` cannot remove the seed mirror. The channel push also carries its own seed frame (`[CHANNEL_PUSH] ... seedFrame=1316ch`), so a missing mirror alone does not make a banner blind. **Left: the blind banner and its redraw with one sound, and (b), on the Mi 9T.**
