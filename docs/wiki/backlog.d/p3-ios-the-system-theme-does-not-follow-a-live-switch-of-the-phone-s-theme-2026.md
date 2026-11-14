## P3 - iOS: the system theme does not follow a live switch of the phone's theme (2026-10-19)

target: 1.8.0

**Re-read 2026-11-11: unchanged** (no trait observer in the iOS sources).
The window override pins `prefers-color-scheme` to the page's own command, so in the `system` preference the iOS app reads the phone at start only (true since 2026-09-30; made explicit by the camera fix). Following it live needs native to post the screen's trait style to the page. [android-ios-parity](../frontend/android-ios-parity.md#the-system-theme-on-ios-is-read-at-start-only)
