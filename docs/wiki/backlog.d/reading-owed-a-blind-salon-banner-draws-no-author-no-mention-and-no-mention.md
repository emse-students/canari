## Reading owed - a blind salon banner draws no author, no mention and no mention route, and a held mention's redraw does not sound twice

target: 1.7.0

**What is built:** a blind salon banner draws no author, no mention and no mention route, and a held mention's redraw does not sound twice (2026-10-22; Android JVM-tested and source-pinned, NOTHING native compiled or run here, the NSE XCTest not wired)

**The reading that closes it:** next pre-release, app killed, a salon mention of the reader: on the Mi 9T with the seed held back, one generic banner on `canari_messages` with the salon's initials and no "mentioned you", then the redraw with the author and the mention, ONE sound in all (`reposted silent` in logcat); the same with the blind banner swiped away before the seed (`existing=false`, still one sound); and how MIUI treats a silent group child; on the iPhone 12 the blind banner plays the message trill, not the mention one. iOS never redraws, so a blind mention stays an ordinary banner for good ([channel-encryption](../protocols/channel-encryption.md#215-the-native-readers-wp-g2-4b))
