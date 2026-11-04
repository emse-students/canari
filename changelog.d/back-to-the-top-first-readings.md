### Fixed - re-tapping the open tab on Android and the web, and the iOS status bar tap, now scroll to the top

Both did nothing on `1.6.4-alpha.3`: the document's link listener navigated before the tab's own handler ran, and the iOS catcher was a 1 pt, nearly transparent strip no status bar tap reached ([mobile](docs/wiki/frontend/mobile.md#back-to-the-top-a-re-tap-of-the-open-tab-and-the-ios-status-bar-owner-2026-11-04)).
