### Fixed - on iPhone the composer no longer hides behind the rising keyboard, and rides it down

The keyboard's rise is handed to the page before the WebView is resized, as on Android, so the
composer stands above the keyboard from its first frames; on a fall the composer and the thread ride
down with the keys, as in Messenger
([keyboard-and-send-motion](docs/wiki/frontend/keyboard-and-send-motion.md#5-ios-measured-on-the-iphone-12-2026-11-13)).
