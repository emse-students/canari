### Fixed - a push catch-up that yields to the app in front no longer posts a fallback banner (Android)

The catch-up answered "nothing" when the foreground took the MLS state over, which read as a refusal: a worker was enqueued and a generic banner posted while the app was open. It now answers the yield ([mobile](docs/wiki/frontend/mobile.md#background-mls-decrypt-ladder)).
