### Fixed - a reply typed in an Android banner over the open app goes out at once

It used to sit queued until the app was backgrounded, its banner reading `non envoyé`: the receiver
now hands it to the page in front, as iOS does
([mobile](docs/wiki/frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)).
