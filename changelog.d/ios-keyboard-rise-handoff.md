### Fixed - on iPhone the composer no longer hides behind the rising keyboard

The keyboard's rise is handed to the page before the WebView is resized, as on Android, so the
composer stands above the keyboard from its first frames instead of sliding up behind it for ~150 ms
([keyboard-and-send-motion](docs/wiki/frontend/keyboard-and-send-motion.md#5-ios-measured-on-the-iphone-12-2026-11-13)).
