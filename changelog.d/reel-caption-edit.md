### Fixed - editing a CanaReel's caption no longer answers 400

The edit form sent the reel's own video back as `media`, which the server refuses by design; on a reel it now sends the caption alone and draws no attachment chip. See [reels](docs/wiki/services/reels.md).
