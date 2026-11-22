### Added - an Android phone whose System WebView is too old now says so, instead of showing a blank page

A guard in `app.html` draws an "update Android System WebView" screen (Play button, version detected) below Chrome 111 (a bundle that fails to parse is only logged); the startup log names the WebView version ([mobile](docs/wiki/frontend/mobile.md#an-old-android-system-webview-shows-an-update-screen-not-a-blank-page-owner-2026-11-21)).
