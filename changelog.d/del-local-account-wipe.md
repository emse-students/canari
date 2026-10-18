### Fixed - deleting an account removes its local message database and vault slot from the device

Only that account's database and device-key vault slot go (never another account's, never a device reset); `mls.bin` stays, it is one file per install ([auth](docs/wiki/frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)).
