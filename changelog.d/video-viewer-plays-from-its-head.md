### Fixed - the full-screen viewer of a streaming video plays from its head instead of waiting for the whole file

The viewer opened from a feed video took a fork of the card's stream (its own MediaSource over the same segments, paced 30 s ahead) rather than lifting the pacing and waiting for the last segment: a 33 MB video started after 26 s, now after its head, and no segment is fetched twice ([reels](docs/wiki/frontend/modules/reels.md)).
