### Fixed - Android: a notification posted while the app was open now goes when the conversation is read on another device

The WebView now cancels the banner it posted when it learns over its socket that the account read the conversation elsewhere, and a salon's `channel_read` push acts while the app is in front ([social-service](docs/wiki/services/social-service.md)).
