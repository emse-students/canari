### Fixed - the frontend CI job rebuilt oxvelte on every run despite a cache hit

The cache restored the binary without cargo's install record, so the install check rebuilt it each time (about 1m40s); the record is cached now ([durable-rules](docs/wiki/durable-rules.md)).
