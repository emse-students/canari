### Fixed - the iPhone's photo picker keeps every item of a multiple pick

An 11-item pick gave 3 attachments: the picker plugin copied each item to a file named after its source, so two items sharing a name overwrote each other. The crate is now vendored with one directory per item, and a file that still cannot be read is counted in a notice ([chat](docs/wiki/frontend/modules/chat.md)).
