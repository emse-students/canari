### Fixed - a commit race no longer holds a commit past the product's own deadline

`raceCommits` waited 45 s for every racer's commit while the client aborts a commit POST after 30 s and resubmits it, so CC-1's winner was measured against that deadline instead of the race; the hold is now 20 s, asserted under `requestDeadline.ts`'s `write` deadline (`RACE_HOLD_MS` in `tools/cross-client-harness/ccrows.mjs`).
