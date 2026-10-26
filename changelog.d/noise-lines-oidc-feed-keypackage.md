### Fixed - three noisy lines of the 1.4.1 dev campaign, each explained at its source

A sign-in no longer reads as a profile change (and no longer writes an `UPDATE`) because `jsonb` hands the cursus keys back in its own order; the feed-audience read no longer logs a line per feed load; a client whose first KeyPackage round is running no longer asks the server for a package it cannot hold yet ([backlog](docs/wiki/backlog.md)).
