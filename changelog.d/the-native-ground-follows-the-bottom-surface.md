### Fixed - the strip under the Android tab bar no longer stays a conversation's grey

The ground painted under the WebView was posted once per keyboard rise and never reset; it is now re-read from the bottom edge whenever that surface changes, and posted only when it differs ([keyboard-and-send-motion](docs/wiki/frontend/keyboard-and-send-motion.md)).
