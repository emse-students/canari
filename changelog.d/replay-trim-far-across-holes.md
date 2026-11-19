### Fixed - a replay with a long pause no longer downloads the media after it again on every tick

The trim kept only the next 60 s of media time and dropped what lay just after a pause of a minute or more; it now keeps what the walk across the holes reaches ([live-replays](docs/wiki/live-replays.md#the-far-ahead-trim-follows-the-walk-not-media-time-alpha4-defect-2026-11-19)).
