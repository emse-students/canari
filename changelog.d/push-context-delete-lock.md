### Fixed - an account deletion no longer removes the push context a new sign-in stores meanwhile

The owner check and the removal now hold one lock with every writer of `push_context.json` ([auth](docs/wiki/frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)).
