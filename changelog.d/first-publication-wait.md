### Fixed - no KeyPackage read while a client's first publication runs

`externalJoin` no longer asks the server for a package the first round has not yet published (a certain 404); it reads when that round settles ([backlog](docs/wiki/backlog.md)).
