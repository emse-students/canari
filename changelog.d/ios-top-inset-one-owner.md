### Fixed - the iPhone no longer shows a white band above the header

The status bar's inset could be counted twice, by UIKit and by the page, when the app started without becoming active at once. One native function now owns both halves ([parity](docs/wiki/frontend/android-ios-parity.md#11-the-two-platforms-took-opposite-decisions-about-the-system-bars---fixed-2026-08-28)).
