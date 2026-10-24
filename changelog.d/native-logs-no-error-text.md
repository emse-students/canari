### Fixed - no iOS log line carries an error's text or a shared file's name

`NSLog` lines say an error's domain and code instead of its `localizedDescription`, the picked-file commands log a share id instead of a path, and a waiting iOS share is kept out of backups with its text capped at 1 MiB ([mobile](docs/wiki/frontend/mobile.md#what-a-native-log-line-may-carry-2026-10-22), [sharing](docs/wiki/frontend/sharing.md#share-in-ios---the-path)).
