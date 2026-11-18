### Fixed - deleting an account no longer logs a false "push deregistration refused" error

The erasure already removed the device's push token, so the sign-out that follows skips the call that could only be refused ([sessions](docs/wiki/sessions.md#a-session-that-ends-takes-its-devices-push-registration-with-it-2026-10-22)).
