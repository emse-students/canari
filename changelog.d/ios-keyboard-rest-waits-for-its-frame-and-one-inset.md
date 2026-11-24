### Fixed - iPhone: a DM thread keeps its end when the keyboard comes back with the app, and the keyboard is taken off the page once

The keyboard's rest now waits for the WebView's frame on both sides of the bridge, and WebKit's own keyboard inset is detached so the shell's frame is the only one ([chat](docs/wiki/frontend/modules/chat.md#a-rest-is-two-facts-the-keyboard-at-rest-and-its-frame-landed-2026-11-24), [keyboard](docs/wiki/frontend/keyboard-and-send-motion.md#the-shell-is-the-one-authority-over-the-keyboards-room-2026-11-24)).
