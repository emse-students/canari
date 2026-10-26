### Fixed - no Welcome to a device the commit gate did not admit

An accepted commit now names the admits it dropped (`refusedAdmits`), so a member adding a device revoked mid-Add sends it no Welcome and stops asking about it for the rest of the sweep; a Welcome refused `WELCOME_TARGET_UNKNOWN` is typed and no longer owed ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-device-the-gate-did-not-admit-is-owed-no-welcome---the-commits-answer-says-so-2026-10-25)).
