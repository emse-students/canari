### Fixed - a member back in a community got none of its past: every seed request went to an offline member

The seed-repair election now reads each member's presence from the roster and elects only an online holder; with nobody online, the request waits for one to come back ([channel-encryption](docs/wiki/protocols/channel-encryption.md#wp-33-and-the-answerer-nobody-elects)).
