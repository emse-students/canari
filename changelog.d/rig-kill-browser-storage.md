### Changed - a KILL row's browser kill checks the profile's storage on both sides

A whole-browser kill can leave a Chrome profile without its quota database, and the revived page then has no storage and can only show its gate. The rig now asserts the quota database before the kill and probes the revived page's storage before the PIN, so that loss is a rig ERROR naming itself, not a product LOCKED ([backlog](docs/wiki/backlog.md)).
