### Changed - Android: the conversation rides the keyboard up and down, and the WebView is never resized for it

The shell announces each keyboard change with its duration and curve, and the page lays itself out over the keyboard and rides the composer and the thread's rows on that curve - no more cropped frame on a rise or composer stuck up on a fall ([keyboard-and-send-motion](docs/wiki/frontend/keyboard-and-send-motion.md#6-android-since-2026-11-14---the-keyboard-covers-the-webview-and-the-page-rides-it)).
