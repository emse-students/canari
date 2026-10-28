### Fixed - a revoked device's leaf is removed from community and salon key groups, for a member with another device there

The key-group roster pass now asks which of the leaves it keeps belong to a revoked device and removes them by device, as conversations already did, for a member who still has another device in that group ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)).
