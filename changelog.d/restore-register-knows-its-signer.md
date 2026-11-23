### Fixed - a sideloaded Android build no longer warns at every start that the estate refused its restore key

The app now reads which certificate signs it and compares it with the origins the server accepts
before it mints a restore key, so an APK installed outside Play mints nothing and says so once at log
level, instead of being refused once per version and warning at every later start
([account-restore](docs/wiki/account-restore.md#a-build-the-estate-does-not-vouch-for-is-known-before-any-key-2026-11-23)).
