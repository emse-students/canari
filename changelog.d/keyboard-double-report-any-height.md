### Fixed - a short keyboard no longer moves the composer for a frame on Android

The WebView's double report of a keyboard rise is now recognised by its shape, not by a 160 px threshold, so a 90 px keyboard is absorbed like a tall one ([chat](docs/wiki/frontend/modules/chat.md#every-keyboard-rise-moves-the-composer-for-a-moment-on-both-phones-measured-2026-10-02-fixed-2026-10-09-reading-owed)).
