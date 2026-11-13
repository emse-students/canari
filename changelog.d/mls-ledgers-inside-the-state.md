### Fixed - the seen-ciphertext marks and the send counts reach the disk with the MLS state they describe

They lived in `localStorage`, which a browser commits seconds after a write, so a browser killed in that delay re-accused frames it had read (KILL-2). They now travel inside the MLS state's own write, and a send's count is in IndexedDB before the frame posts ([backlog](docs/wiki/backlog.md#p1---the-ledgers-that-must-follow-the-mls-state-live-in-localstorage-which-an-unclean-exit-loses-for-seconds-after-each-write-kill-2-2026-10-25-design-owed)).
