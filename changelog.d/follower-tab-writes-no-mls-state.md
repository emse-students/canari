### Fixed - a follower tab wrote its MLS copy over the leader's

A second tab's login replayed archives into its own copy and checkpointed it, and the leader's own writes were then refused as stale behind it. A tab that does not hold the leader copy now never writes MLS state and never decrypts an archive into its copy; it draws the stored pages ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-follower-tab-wrote-its-mls-copy-over-the-leaders-2026-11-10)).
