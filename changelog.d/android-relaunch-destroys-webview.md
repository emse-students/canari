### Fixed - Android: a navigation-mode switch no longer leaves the old page alive and holding refused texts

A relaunch the manifest cannot absorb (navigation mode, WebView update) now destroys the old WebView, which kept its Web Locks and withheld unsent salon texts from the new page ([mobile](docs/wiki/frontend/mobile.md#a-relaunched-activity-left-its-webview-alive-and-the-orphan-kept-its-web-locks-2026-10-14)).
