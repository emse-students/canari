### Fixed - the call worker's "undecryptable" test no longer times out under a parallel full run

The test sealed 249 foreign frames with real AES-GCM before exercising the receiver; one seal repeated fails identically, so it now seals once. Same assertions, same 100th-failure boundary ([testing-methodology](docs/wiki/testing-methodology.md)).
