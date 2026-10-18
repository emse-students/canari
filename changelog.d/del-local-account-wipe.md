### Fixed - deleting an account removes its local message database and vault slot from the device

Only the account the server deleted (the token's subject, never the page's) loses its local data - every per-account key through one guarded list, never another account's, never a device reset, `mls.bin` stays; an interrupted wipe resumes at the next start without touching an account signed back in ([auth](docs/wiki/frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)).
