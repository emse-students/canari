### Fixed - a leaf-refresh decision no longer overwrites the entry of an own commit that merged while it ran

The observation is written only for the leaf still in the state, and an active group whose tree holds no leaf of this device is reported once per epoch as a defect instead of passing for an inactive one ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh)).
