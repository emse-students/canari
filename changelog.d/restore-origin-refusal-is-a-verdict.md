### Fixed - a restore key from a build the estate does not vouch for is refused once per version, not at every start

The server names that refusal `RESTORE_ORIGIN_NOT_ALLOWED` instead of `RESTORE_REGISTRATION_INVALID`, and the client records it and mints no key again until the version changes ([account-restore](docs/wiki/account-restore.md#the-server---core-service-apiauthrestore)).
