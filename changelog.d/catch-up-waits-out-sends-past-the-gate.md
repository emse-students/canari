### Fixed - a history catch-up is no longer thrown away by a send already under way

A web catch-up now waits for the sends already past the send gate before it snapshots, so their
encrypt can no longer land after the snapshot and get the catch-up's work discarded
([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md)).
