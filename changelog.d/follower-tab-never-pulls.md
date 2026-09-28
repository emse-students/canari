### Fixed - a follower tab pulled and decrypted the leader's queue on every mailbox barrier

37 pulls of the same rows in ten seconds, measured on production; a follower now pulls nothing ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-follower-pulled-the-leaders-queue-on-every-barrier-2026-09-28)).
