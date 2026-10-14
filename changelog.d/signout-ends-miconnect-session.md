### Changed - signing out of Canari also ends the MiConnect session

A sign-out somebody chose now goes through MiConnect's end-session, so the next sign-in asks who you are instead of coming back as the account that left; a dead session still goes straight to `/login`, and an offline sign-out completes locally and says so ([auth](docs/wiki/frontend/modules/auth.md#signing-out-ends-the-miconnect-session-2026-10-14), [authentik](docs/wiki/infrastructure/authentik.md#signing-out-of-canari-ends-the-miconnect-session-2026-10-14)).
