### Fixed - a history replay's stream cursor no longer lands before the checkpoint it claims to follow

Closing a bulk-ingest window starts the encrypted checkpoint without awaiting it, so the replay's cursor and seen-hash markers were written ahead of the MLS state for one checkpoint; they now wait for a checkpoint that started after the replay, and are withheld when it fails ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#a-history-replays-markers-wait-for-the-checkpoint-that-holds-it-2026-10-21)).
