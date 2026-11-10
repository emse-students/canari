### Fixed - a CanaReel's video fills its frame instead of floating in it with black bands

The reel viewer's `<video>` had no size of its own and was drawn at the clip's intrinsic size, so any clip smaller than its frame (a 720p clip on a wide desktop window, a near-square clip) showed bands on all four sides. It now takes the whole frame, `cover` unless the clip is clearly another shape (more than 20 % to crop). Rule and measurements: [reels](docs/wiki/frontend/modules/reels.md#a-reels-video-fills-its-frame-owner-2026-11-09).
