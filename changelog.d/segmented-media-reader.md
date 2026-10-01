### Added - segmented media: the reader release (CanaReels R2)

Every client now reads a video sealed in 1 MiB authenticated segments (STREAM), and the media service serves byte ranges, so a later release can play a video while it downloads; nothing writes the format until the writer flip ([media-service](docs/wiki/services/media-service.md#segmented-media-play-while-downloading-canareels-r2---the-reader-release-2026-10-01)).
