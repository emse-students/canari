### Fixed - a burst of unreadable frames of one group is evaluated once, not once per frame

A cold start replaying dozens of unreadable frames raised the same history ask for each one and logged "not asking again" every time; the first now asks and the rest are counted into one line ([history reconciliation](docs/wiki/protocols/mls-graine-state-machine.md)).
