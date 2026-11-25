### Fixed - a message push the network refused becomes its real text once the network is back (Android)

A push whose commit catch-up could not reach the server was treated as a refusal: a worker that only sweeps the database, a log line blaming the decryption, and a generic "Nouveau message" line nothing ever upgraded. The failure is now its own outcome, the frame is held and replayed on network return, and the real line replaces the generic one ([mobile](docs/wiki/frontend/mobile.md#a-push-the-network-refused-is-held-and-replayed-2026-11-25)).
