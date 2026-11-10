### Fixed - the store screenshot tools pass the tools lint gate

Four lint warnings in `tools/store-screenshots` failed `make test-harness` on every pull request that runs it; they are removed, with no change in behaviour ([store-listings](docs/wiki/store-listings.md)).
