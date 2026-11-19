### Fixed - dragging a replay's bar again while it loads no longer throws the playhead back

Only the latest seek may move the playhead; an older seek's download is cancelled and its result ignored ([live-replays](docs/wiki/live-replays.md#a-replay-seek-the-latest-target-alone-moves-the-playhead-owner-2026-11-19)).

### Fixed - a replay no longer freezes at a camera flip or a background pause of its live

The holes the live had are known from the segment list and crossed by construction, a seek into one lands after it ([live-replays](docs/wiki/live-replays.md#holes-in-the-replay-timeline-crossed-by-construction-s11-2026-11-19)).
