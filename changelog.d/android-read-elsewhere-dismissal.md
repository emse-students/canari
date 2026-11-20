### Fixed - Android: a notification posted while the app was open now goes when the conversation is read on another device

The WebView now hands every own read it learns over its socket to the native side, which records it (a late post of a read message is refused) and removes the banner once nothing is unread; a salon's `channel_read` push acts while the app is in front ([social-service](docs/wiki/services/social-service.md)).
