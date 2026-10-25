### Fixed - OFF-3 waits for the cut member's add lock to leave the server before the second member's Add

W1 is cut while holding `mls:addlock:<group>`, so W2's Add 15 s later was cancelled at the lock and the row recorded INVALID. The row now waits for the key to be gone on the server, which is a fact and not a guessed TTL ([cross-client-testing](docs/wiki/cross-client-testing.md)).
