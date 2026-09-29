### Fixed - a community salon stays blank when this device's own leaf was removed from its key group

A device that joined a key group twice had its first leaf removed by OpenMLS, and a state restored from before the second join was taken as "held" on every load. It now re-joins ([channel-encryption §22.2](docs/wiki/protocols/channel-encryption.md#222-a-key-group-held-with-its-own-leaf-removed-is-not-held---fixed-2026-09-29)).
