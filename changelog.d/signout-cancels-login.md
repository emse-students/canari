### Fixed - a sign-out during a login in progress now stops that login

The login re-reads the sign-out generation after every await and, once a sign-out began, stops without setting `isLoggedIn` and releases its gateway socket and MLS client ([auth](docs/wiki/frontend/modules/auth.md#a-sign-out-during-a-login-in-progress-completed-the-login---fixed-2026-10-18)).
