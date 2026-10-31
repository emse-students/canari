### Changed - a conversation refuses an entry no member made

A conversation now refuses a commit that brings in a person nobody added, and stops following that group instead of rebuilding from the server's state; key groups are unaffected ([mls-protocol](docs/wiki/protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).
