### Fixed - a sign-out now deregisters the push token before it revokes the session, and no longer closes a socket twice

The server's push deregistration raced the revocation and came back `HTTP 401` (Android, `1.6.7-alpha.3`); `clearAuth` now awaits it first, and a transport failure is a warning naming what stayed registered. A `Close` arriving while the socket is released no longer ends in a native disconnect on a closed connection ([sessions](docs/wiki/sessions.md#a-session-that-ends-takes-its-devices-push-registration-with-it-2026-10-22)).
