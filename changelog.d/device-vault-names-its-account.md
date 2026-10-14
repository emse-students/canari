### Fixed - a second account signing in on one device no longer unlocks with the first account's saved key, nor erases its messages

The device-key vault now names the account it belongs to: a sign-in as anyone else goes to its own PIN, and a vault written by an older build must prove its owner before it is used, rotating nothing if it cannot ([auth](docs/wiki/frontend/modules/auth.md#the-vault-names-its-account---fixed-2026-10-14)).
