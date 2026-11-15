### Changed - the waiting-seat ring reading is closed; the uninvited-entry design entry it lived in is deleted

A link joiner held outside by `awaitingAdmission` is not rung: `[ring] ... has no other member to ring` on dev, `1.6.12-alpha.2` ([device-verification](docs/wiki/device-verification.md#where-the-pass-stands)). The standing rule for the first `[UNINVITED_ENTRY] kind=new-person` line after the stable carrying #3519 stays in [mls-protocol](docs/wiki/protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).
