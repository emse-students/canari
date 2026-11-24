### Fixed - the iPhone share sheet no longer offers the previous account's sender after a sign-out

The sign-out's erase now also runs `INInteraction.deleteAll` (awaited, after the notification extension's group delete), and says its outcome at INFO so the exported log records it ([backlog](docs/wiki/backlog.d/p2-the-share-sheet-still-offers-the-previous-account-s-sender-after-a-sign-out.md)).
