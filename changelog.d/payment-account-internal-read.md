### Fixed - the Lydia validation button, connect-status and the Stripe dashboard link all said "Association not found"

core-service read an association through a route that became login-only on 2026-08-05; it reads a dedicated internal one now ([core-service](docs/wiki/services/core-service.md#payments-stripe--lydia)).
