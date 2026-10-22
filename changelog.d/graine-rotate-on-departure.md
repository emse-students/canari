### Changed - a community seed now outlives a new device, never a removal or a new member

A key group's clean run is kept in the MLS state by `mls-core`, ended by any Remove, by a new user and by any external-commit join; a sender re-distributes its session across an Add of a device instead of minting one. The server now refuses an external commit whose new leaf does not name the caller's own device. See [graine-removal-tracker](docs/wiki/protocols/graine-removal-tracker.md).
