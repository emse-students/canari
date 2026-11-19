### Fixed - dragging a replay's bar again while it loads no longer throws the playhead back

Only the latest seek may move the playhead; an older seek's download is cancelled and its result ignored ([live-replays](docs/wiki/live-replays.md#a-replay-seek-the-latest-target-alone-moves-the-playhead-owner-2026-11-19)).
