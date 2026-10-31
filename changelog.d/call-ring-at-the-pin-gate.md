### Fixed - a call to an app open at the PIN gate rings

The native ring stood back whenever the app was in front, but a page at the PIN gate holds no gateway socket and never gets the caller's invite, so nothing rang. The native ring now stands back only while the page holds that socket, on Android and on the iPhone ([calls](docs/wiki/frontend/modules/calls.md#an-open-app-at-the-pin-gate-rang-nothing-153-2026-10-31)).
