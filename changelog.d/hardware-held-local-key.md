### Changed - on phones, the local key is held by secure hardware and backups have their own recovery code

The phone apps re-key their local data once under a random key held by the device's secure hardware, the PIN checked by the server; backups are sealed under one recovery code per device, and a phone that re-keyed existing data asks for a new backup ([auth](docs/wiki/frontend/modules/auth.md#the-at-rest-key-on-a-phone-is-held-by-the-hardware-2026-10-22)).
