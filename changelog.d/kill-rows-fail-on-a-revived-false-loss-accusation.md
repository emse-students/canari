### Changed - the kill rows fail a revived seat that accuses a frame it had read

KILL-1/2/3 now fail a run whose revived browser prints `frame never read here and unreadable for good`, read over its whole console including the catch-up its PIN unlock starts; the same line had only made KILL-3 `PASS-DIRTY` ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#the-ledgers-that-describe-the-state-travel-inside-it-kill-2-2026-10-26)).
