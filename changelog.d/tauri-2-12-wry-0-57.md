### Changed - tauri 2.12 (wry 0.57, tao 0.37) with the store, opener and http plugins; the vendored tao fork is gone

wry no longer aborts the process on an unparsable URL, and tao 0.37 carries the Android `getType()` null guard the fork existed for, so `frontend/src-tauri/patches/tao` is deleted. See [backlog](docs/wiki/backlog.md) and [mobile](docs/wiki/frontend/mobile.md#the-app-owns-which-urls-its-own-webview-may-load).
