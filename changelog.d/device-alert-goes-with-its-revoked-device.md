### Fixed - A new-device alert no longer outlives its device

Opening the notifications list drops the alert of a device the server says is revoked; a failed read drops nothing ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
