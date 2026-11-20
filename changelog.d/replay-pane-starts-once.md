### Fixed - opening a replay from a feed card starts its player once, not twice

The page's effect read the `post` object, so the reel list answering again with a new object for the same replay stopped the player and started another (the listing and segment 0 fetched twice); it now follows the live id alone ([live-replays](docs/wiki/live-replays.md#the-replay-page-starts-its-player-once-s13-2026-11-20)).
