### Fixed - a sign-out ends the device's push registration

The device deletes its push token and push material at every sign-out, and the server ends the device's push registration when it ends the session - each side on its own ([sessions](docs/wiki/sessions.md#a-session-that-ends-takes-its-devices-push-registration-with-it-2026-10-22)).
