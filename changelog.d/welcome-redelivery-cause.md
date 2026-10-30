### Fixed - a key-group join no longer races an admitter's Add

The "already held - redelivered Welcome" seen on the rig's community rows was never a redelivery. The device had joined over an Add that landed between its seat read and its base read. The seat is now read after the base the join builds on ([channel-encryption](docs/wiki/protocols/channel-encryption.md)).
