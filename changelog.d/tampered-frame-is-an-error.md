### Changed - a tampered or truncated MLS frame is pinned as an error, never a panic

openmls 0.9.0 dropped the debug assert that made 0.8.1 panic on a corrupted PrivateMessage body; `tampered_private_message.rs` now pins the refusal and that the group reads the next honest frame ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
