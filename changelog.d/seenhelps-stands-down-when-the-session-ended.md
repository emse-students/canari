### Fixed - a revoked device's reset no longer logs a `[seenHelps]` read failure at error level

The seen-set read recognises the typed session end and stands down at info level ([sessions](docs/wiki/sessions.md#a-session-that-ends-takes-its-devices-push-registration-with-it-2026-10-22)).
