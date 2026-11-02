### Fixed - A disposed upload no longer shows `stalled`, and the reel-resume tests stop failing under load

A disposed or withdrawn transfer stuck behind a dead socket kept its stall-hint timer and wrote `stalled` into the next view of the same id, and its late progress events recreated a cleared view: both stop at the abort. `outbox.reelResume` also waited on events inside `vi.waitFor`'s 1 s default and read the take record once, a write before it says `sent` ([test-suite-reform](docs/wiki/test-suite-reform.md#8-intermittent-local-failures-under-load-read-2026-10-30)).
