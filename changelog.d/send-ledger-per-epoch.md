### Fixed - a reload after a commit no longer re-uses generations its peers already consumed

The send ledger counts each frame against the epoch it was sealed at, and a burn owed to an epoch the restored state has not reached is spent, once and before any send, when the group gets there; no checkpoint declares that ratchet durable before then ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)).
