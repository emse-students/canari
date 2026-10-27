### Fixed - revoking a private salon's member commits their removal at once

The device that revokes the access now commits the key-group Remove right after the server accepts it, instead of leaving it to the next app load ([channel-encryption](docs/wiki/protocols/channel-encryption.md#the-actor-of-a-removal-commits-it---2026-10-27)).
