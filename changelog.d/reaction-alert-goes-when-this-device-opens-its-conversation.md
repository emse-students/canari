### Fixed - a reaction's alert raised while the app was open goes when you open its conversation

An alert the frame trigger raised on Android for a conversation off screen stayed in the shade after
you opened that conversation in the same session: no push and no read echo reaches the device that
took the read. The reading is now handed to the native cancel once per reading, which removes the
banner and the reaction unless a newer message is unread (iOS, desktop and web take down the ones the page raised)
([mobile](docs/wiki/frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17)).
