### Fixed - an iPhone announces a message once, and a conversation's banners all go with it

A cold launch or a resume no longer raises the page's own banner for a message the notification extension already showed (two rows, then three, on `1.7.3-alpha.6`): both processes claim it in one shared ledger, and every banner the page raises is filed under its conversation's thread, so a deleted group takes all of them ([ios-notification-ownership](docs/wiki/frontend/ios-notification-ownership.md)).
