### Fixed - on Android, two members writing in the same millisecond are two notifications, not one

The announced-message key and the shade's own line match now carry the sender, as iOS's ledger has since #3968; a trigger that does not know the sender still matches the one that does ([ios-notification-ownership](docs/wiki/frontend/ios-notification-ownership.md)).
