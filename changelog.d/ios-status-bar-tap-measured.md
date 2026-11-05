### Fixed - the iOS tab bar plugin's native log lines are readable on a store build

Its Swift `NSLog` lines reached the device log as `<private>`, which made the `1.6.4-alpha.4` status bar tap look as if the catcher was never chosen. Measured on the iPhone 12, the catcher is what scrolls the feed to the top, and the dead band under the status bar comes from iOS, not from the app ([mobile](docs/wiki/frontend/mobile.md#back-to-the-top-a-re-tap-of-the-open-tab-and-the-ios-status-bar-owner-2026-11-04)).
