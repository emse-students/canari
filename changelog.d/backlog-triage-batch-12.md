### Fixed - one unconfirmed tree no longer aborts a group's whole pending sweep

The automatic Adds of a sweep shared the pass's tree even when it could not be confirmed; the next
row now reads it afresh ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
