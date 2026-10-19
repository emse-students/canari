### Changed - the source-scan tests read one shared snapshot of the tree instead of walking it 19 times

A vitest `globalSetup` snapshots `src` once per run and `src/test/sourceTree.ts` replaces the nine copied walkers, so the scans no longer time out under full-suite load (89 timeouts in 20 loaded runs, none after); `ChatArea.entryWindow` mounts 80 rows instead of 300. No app byte changes ([test-suite-reform](docs/wiki/test-suite-reform.md#wp-t9-s---one-walk-of-the-source-tree-for-every-scan-2026-10-19)).
