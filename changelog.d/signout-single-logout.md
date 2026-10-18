### Fixed - one sign-out sends one logout, and "Rester connecte" no longer logs the user back in during it

`clearAuth` now drops the local identity before it awaits the revocation, and a refresh answered during the sign-out can no longer restore it, so the vault unlock cannot start mid-sign-out and no second sign-out follows ([auth](docs/wiki/frontend/modules/auth.md#one-sign-out-sent-two-logouts-and-the-vault-logged-the-user-back-in-during-it---fixed-2026-10-17)).
