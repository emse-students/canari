### Fixed - a caught-up history batch logs a count, and a held seed is read from the store once

`[HISTORY]` prints the caller's bound and the stream head apart, and the batch route counts caught-up groups instead of writing one `after=X until=X entries=0` line each; an arriving copy of a held Graine seed is answered from the seed cache ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#and-on-the-server-side-a-history-line-names-who-asked)).
