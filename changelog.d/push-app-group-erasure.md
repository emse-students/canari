### Fixed - an account deletion on iOS no longer leaves its push context in the App Group

The mirrored `push_context.json` (with its bearer push token) and the extension's decrypted cache are now removed from the App Group on the same owner proof ([auth](docs/wiki/frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)).
