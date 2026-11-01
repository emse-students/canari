### Fixed - no KeyPackage read while a new device's first publication runs

`externalJoin` on a device minted in this boot no longer asks the server for a package its first round has not yet published (a certain 404); it reads when that round settles. A returning device still reads at once ([backlog](docs/wiki/backlog.md)).
