### Fixed - a departed member's removal found by a roster diff is staged only on the published branch

The conversation stray sweep and the key-group roster pass now stage their removal through the same fork check as the leaf refresh and the revoked-device removal ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh)).
