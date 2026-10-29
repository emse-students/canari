### Added - a test settles how an unmerged external join is held and dropped

openmls 0.9 merges an external commit inside `finalize`, so "unmerged" is mls-core's sealed marker alone; dropping the join leaves the key store byte-identical, and keeping the group after a clear leaves it unusable. See [mls-protocol](docs/wiki/protocols/mls-protocol.md#device-binding).
