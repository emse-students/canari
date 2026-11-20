### Fixed - iOS: Canari's local data no longer travels to a new iPhone through a backup

A new iPhone restored from a backup arrived with the old phone's local stores but not their
device-only key, and the PIN screen called the data unreadable. Every launch now excludes the data
directory, WebKit's stores, the preferences and the App Group from backups
([mobile](docs/wiki/frontend/mobile.md#nothing-local-travels-to-another-phone-2026-11-20)).
