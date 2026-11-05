### Fixed - a restore key from a build the estate does not vouch for is refused once, not at every start

The server names that refusal `RESTORE_ORIGIN_NOT_ALLOWED`, and the client records it against its version and the estate's accepted origins: it mints no key while both hold, says so at `warn` each start, and heals at the next start once either changes ([account-restore](docs/wiki/account-restore.md#the-server---core-service-apiauthrestore)).
