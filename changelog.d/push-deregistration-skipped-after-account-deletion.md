### Fixed - deleting an account no longer logs a false "push deregistration refused" error

The account is gone, so the sign-out that follows skips the call that could only be refused (the erasure job removes the push token) ([sessions](docs/wiki/sessions.md#a-session-that-ends-takes-its-devices-push-registration-with-it-2026-10-22)).
