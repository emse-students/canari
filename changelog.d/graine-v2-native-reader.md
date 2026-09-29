### Security - Android and iOS notifications read Graine v2: author, salon, floor and signature are checked natively, and a DM push naming another sender is refused

One Rust implementation serves both platforms. An arriving v2 seed is mirrored only once the key group's tree endorses it ([channel-encryption §21.5](docs/wiki/protocols/channel-encryption.md#215-the-native-readers-wp-g2-4b)).
