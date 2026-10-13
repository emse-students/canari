### Fixed - closing a poll asks in the app's own dialog

The early close of a salon poll used the browser's `window.confirm`, which Android draws with English "CANCEL" / "OK" under a French sentence; it now uses the app's confirmation, labelled in the reader's language ([device-verification](docs/wiki/device-verification.md#the-mi-9t-readings-of-v126-alpha1-2026-10-13)).
