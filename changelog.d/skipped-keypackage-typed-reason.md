### Changed - a skipped KeyPackage now says why

`add_members_bulk` returns a typed reason per refused KeyPackage (expired, bad signature, undecodable, ...) and the inviter logs one line per cause; the server-side partition is still owed ([chat-delivery](docs/wiki/services/chat-delivery.md#a-roster-seat-is-not-a-key-and-only-a-welcome-tells-the-two-apart)).
