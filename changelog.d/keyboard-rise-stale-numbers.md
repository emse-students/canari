### Fixed - the composer no longer jumps for a moment when the keyboard rises

Android's WebView reported the keyboard's height twice for 60-100 ms and iOS kept its home-indicator inset for ~400 ms; the first is now read as the layout viewport, the second is pinned to 0 while the keyboard is open ([chat](docs/wiki/frontend/modules/chat.md#every-keyboard-rise-moves-the-composer-for-a-moment-on-both-phones-measured-2026-10-02-fixed-2026-10-09-reading-owed)). Owed one reading on both phones.
