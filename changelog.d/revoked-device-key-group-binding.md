### Fixed - a revoked device's leaf is removed from a key group even when it was its owner's only device there

A device revocation now records the community and salon key groups the device held, so the revoked-leaves question can still name its leaf after the purge ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)). Chat-delivery migration 041, additive.
