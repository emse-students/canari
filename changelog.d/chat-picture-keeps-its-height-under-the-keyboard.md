### Fixed - a picture in a message no longer shrinks and crops when the keyboard opens

In the app the keyboard shrinks the WebView, so the `60svh` media ceiling fell from 567 to 353 px on the Mi 9T and a tall screenshot lost its top and bottom; the ceiling now holds the keyboard-free height while a keyboard is up ([chat](docs/wiki/frontend/modules/chat.md#a-picture-keeps-its-height-when-the-keyboard-opens-2026-11-13)).
