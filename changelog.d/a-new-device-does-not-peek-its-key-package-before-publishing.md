### Fixed - a freshly enrolled web device no longer logs three 404s before its first key-package publication

The own-publication peek is skipped for a device minted in this process until its first key package round has settled, whether that round is running or has not started
([key-package-pool](docs/wiki/protocols/key-package-pool.md)).
