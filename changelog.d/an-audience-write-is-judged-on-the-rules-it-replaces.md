### Fixed

- An association's audience write locks the entity, then reads, judges and replaces its rules in one transaction, so two writes of one entity are ordered ([profiles-and-access](docs/wiki/profiles-and-access.md)).
