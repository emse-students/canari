### Fixed - opening a CanaReel now stops the video playing behind it

The feed's video kept playing (with sound if unmuted) until the reel's own player had loaded, and for good behind a photo page or a failed reel, because only a mounted player counted as an open viewer. The viewer now holds playback from its first line and releases it on close. Cause and mechanism: [reels](docs/wiki/frontend/modules/reels.md#what-plays-behind-the-viewer-stops-when-it-opens-owner-2026-11-06).
