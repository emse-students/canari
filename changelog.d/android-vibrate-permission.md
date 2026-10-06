### Fixed - Android haptics never fired: the manifest did not declare `VIBRATE`

Every `navigator.vibrate` (message long-press, reel capture, notifications) was refused by Chromium. See [mobile](docs/wiki/frontend/mobile.md#vibrate-is-a-manifest-permission-and-navigatorvibrate-fails-silently-without-it-2026-10-06).
