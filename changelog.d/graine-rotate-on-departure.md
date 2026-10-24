### Changed - a community seed now outlives a new device, never a removal or a new member

A key group's clean run is kept in the MLS state by `mls-core`, ended by any Remove and by a new user; a sender re-distributes its session across a new device of a present user instead of minting one. The server checks that an external commit's new leaf names the caller's own device. See [graine-removal-tracker](docs/wiki/protocols/graine-removal-tracker.md).
