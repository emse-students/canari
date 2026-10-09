### Fixed - a session whose token names another account than the device is refused, and a 403 send is no longer retried for ever

A token whose `sub` is not the local/MLS user is withheld, the app stops with one notice offering the sign-out, and the outbox parks an entry the server answered 403 instead of re-posting it every minute. See [sessions](docs/wiki/sessions.md#a-token-that-names-another-account-than-the-local-identity-is-refused-2026-10-10).
