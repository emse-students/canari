### Fixed - a loading CanaReel shows its first frame instead of a yellow play button, and the next reel preloads behind the one being watched

A new reel carries a ThumbHash of its first frame from the publisher, a reel this device has decoded shows its sharp first frame, and the play button now answers only a refused autoplay; the next reel's preload waits until the current one is whole and playing ([reels](docs/wiki/frontend/modules/reels.md#a-loading-reel-shows-its-first-frame-never-a-play-glyph-owner-2026-10-31)).
