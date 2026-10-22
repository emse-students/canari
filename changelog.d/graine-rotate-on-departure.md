### Changed - a community seed now outlives a new device, never a removal or a new member

A key group's clean run is kept in the MLS state by `mls-core`, ended by any Remove and by a new user; a sender re-distributes its session across a device join instead of minting one. See [graine-removal-tracker](docs/wiki/protocols/graine-removal-tracker.md).
