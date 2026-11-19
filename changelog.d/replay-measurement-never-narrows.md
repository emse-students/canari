### Fixed - a replay seek into a segment the trim had cut no longer loses 1.2 s of it

Re-taking such a segment measured only the part the buffer lacked, which narrowed its end and made a false hole the playhead skipped over; a measurement now keeps the widest start and end ([live-replays](docs/wiki/live-replays.md#a-measurement-never-narrows-2026-11-20)).
