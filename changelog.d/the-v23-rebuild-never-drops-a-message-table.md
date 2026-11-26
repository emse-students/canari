### Fixed - P1: the v23 rebuild of the local message table could lose a device's whole history; it now proves itself in one transaction, never drops the old table, and the lost rows are asked back from peers

`1.8.1` dropped `messages` and renamed its copy on two pooled connections, and every caller of the failed open then started its own; the open is single-flight now, the swap is one guarded transaction, a replaced table is set aside until proved, and audit generation 2 re-asks every group ([local-store-rebuild](docs/wiki/frontend/local-store-rebuild.md)).
