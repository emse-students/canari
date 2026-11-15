### Fixed - iOS: "Marquer comme lu" from a killed app no longer crashes it after doing its work

The notification response was completed on a background queue and iOS aborted the app ("Call must be made on main thread"); the mark-read and quick-reply branches now finish on the main queue, held by a source test ([mobile](docs/wiki/frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)).
