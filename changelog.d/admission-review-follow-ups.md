### Fixed - the disarmed admission rule leaves nothing behind on a dev device

`forget_group` now forgets a group's admission classification. A `closed` classification and the
freeze list a dev build stored are both removed at startup. Each legitimate self-entry path is
pinned by its own test ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
