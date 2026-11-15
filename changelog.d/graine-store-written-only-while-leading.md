### Fixed - a tab that loses the lead mid-send never writes the salon key store nor hands a request on

A leader frozen inside a salon seal could, on resuming, write back an outbound count the new leader had since advanced, and a leader that lost the lead while running a follower's request could hand it on a second time or report it at error; both are now refused by type at the point the loss is met ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-follower-tab-wrote-its-copy-of-the-mls-state-over-the-leaders---fixed-2026-11-11)).
