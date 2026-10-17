### Fixed - one sign-out sends one logout, and "Rester connecte" no longer logs the user back in during it

`clearAuth` now drops the local identity before it awaits the revocation, so the vault unlock cannot start mid-sign-out and a 401 met meanwhile triggers no second sign-out ([auth](docs/wiki/frontend/modules/auth.md#one-sign-out-sent-two-logouts-and-the-vault-logged-the-user-back-in-during-it---fixed-2026-10-17)).
