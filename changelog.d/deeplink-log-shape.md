### Fixed - deep-link log lines name the link's shape, not its ids or tokens

The web log and the iOS tap log printed the whole link; they now print scheme, host, first route segment and whether a query was present ([durable-rules](docs/wiki/durable-rules.md)).
