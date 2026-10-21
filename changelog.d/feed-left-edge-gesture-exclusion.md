### Fixed - the swipe from the feed to the camera is no longer taken as Back on Android

A swipe started in the feed's left 30 CSS px went Back instead of opening the camera; the feed now excludes that edge band, as conversations exclude the right one ([mobile](docs/wiki/frontend/mobile.md#the-left-edge-back-gesture-is-excluded-over-the-feed-and-only-there-2026-10-21)).
