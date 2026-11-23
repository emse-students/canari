### Fixed - a message the reader left during its write is no longer both read on arrival and notified

The single-message path decided the read on arrival before writing the row and the notification after
it, so a reader backing out in between got a message counted read (no unread, banners retired on the
other devices) and a banner here. One verdict, taken after the writes, now drives all four effects
([mobile](docs/wiki/frontend/mobile.md#an-app-that-is-not-active-is-not-read-2026-11-23)).
