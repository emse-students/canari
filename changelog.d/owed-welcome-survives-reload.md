### Fixed - an accepted Add's Welcome is no longer lost to a reload before its send

Every accepted Add is now merged owing its Welcome in the MLS state, the Welcome send consumes it, and the server stores a re-sent copy once, so the invitee no longer has to let itself in (DUP-7) ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
