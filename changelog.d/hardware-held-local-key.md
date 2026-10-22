### Changed - on phones, the local key is held by secure hardware and backups have their own recovery code

The phone apps re-key their local data once under a random key held by the device's secure hardware, which the PIN only unlocks; a backup is now sealed under a recovery code shown once at export ([auth](docs/wiki/frontend/modules/auth.md#the-at-rest-key-on-a-phone-is-held-by-the-hardware-2026-10-22)).
