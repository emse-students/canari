### Fixed - concurrent pushes no longer time out each other's frontend tests

The push hook's checks that use every core now take one machine-wide slot, so several checkouts pushing at once queue instead of overloading the machine (three concurrent runs: 23-25 timeouts; serialized: 1-7). Two tests also stop paying real sleeps and disk walks inside their deadline ([test-suite-reform](docs/wiki/test-suite-reform.md)).
