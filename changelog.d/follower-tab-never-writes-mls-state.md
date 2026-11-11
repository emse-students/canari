### Fixed - a second tab no longer writes its copy of the encrypted state over the main tab's

A follower tab checkpointed the copy it loaded, so the main tab's next save was refused and, until
it landed, a reload could restore a state behind messages and group changes already applied. Only
the main tab writes the state now
([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-follower-tab-wrote-its-copy-of-the-mls-state-over-the-leaders---fixed-2026-11-11)).
