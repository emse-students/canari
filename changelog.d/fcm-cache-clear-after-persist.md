### Fixed - a push-cached message is deleted from disk only after the app has stored it

The app took the native push cache and deleted it before writing it, so a process death in between lost it - a notification quick reply's only local copy included. It is now moved aside and deleted only once written ([mobile](docs/wiki/frontend/mobile.md#one-row-arriving-through-the-push-the-pull-and-the-socket-measured-2026-09-08-to-2026-10-06)).
