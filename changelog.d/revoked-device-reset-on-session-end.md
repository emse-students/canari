### Security - a device its owner revokes is reset, whether the frame or the dead session tells it first

A refresh refused because an owner's device revocation ended the session now says so (`DEVICE_REVOKED_BY_OWNER`), and the device answers it with the one revocation reset instead of a sign-out that kept its stores; a Welcome to a revoked device is a typed 404, not a 500 ([sessions](docs/wiki/sessions.md#a-refresh-refused-because-the-device-was-revoked-says-so-2026-10-25)).
