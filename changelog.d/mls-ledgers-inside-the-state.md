### Fixed - the seen-ciphertext marks and the send counts reach the disk with the MLS state they describe

They lived in `localStorage`, which a browser commits seconds after a write, so a browser killed in that delay re-accused frames it had read (KILL-2). They now travel inside the MLS state's own write, and a send's count is in IndexedDB before the frame posts ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#the-ledgers-that-describe-the-state-travel-inside-it-kill-2-2026-10-26)).
