### Fixed - a camera refused by the Android permission is said to be denied, with a way to the settings

Android reports a camera the OS refused as the same error as a busy one, so a member was told to close
other apps. The camera error is now classified at the throw from the OS's own permission state (a native
plugin command); the denied sentence appears on the live sheet, the camera tab and the composer, and the
"Ouvrir les réglages" button is native-only and shown only for a denied camera, never a busy one
([live module](docs/wiki/frontend/modules/live.md#a-refused-camera-on-the-pre-live-sheet-2026-11-23)).
