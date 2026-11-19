### Fixed - a seek in a replay lands in the segment of its target, not seconds later

The bar reads media time but the segment lookup read arrival time, which a replay with more media than live (a camera under its nominal rate) leaves behind; the lookup is now in media time, from the measured starts ([live-replays](docs/wiki/live-replays.md#a-seek-looks-its-segment-up-in-media-time-s12-2026-11-19)).
