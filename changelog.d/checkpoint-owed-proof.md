### Changed - a message drain that changed nothing no longer rewrites the MLS state

The skip rests on a proof kept by the MLS manager itself; a drain of read watermarks still moves the ratchet and is still checkpointed ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#a-bulk-ingest-window-that-changed-nothing-durable-writes-nothing---and-a-read-watermark-is-not-nothing-2026-10-14)).
