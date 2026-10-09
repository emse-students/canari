### Fixed - CanaReels recorded 19 frames a second and a hot, clipped sound; the review had black bars

Android recorded VP9 in software and lost a third of the frames; it records hardware H.264 now (30 fps, no gaps), the microphone is asked with no echo cancellation, noise suppression or gain control, and the post-capture screen is a full-bleed loop with no seek bar ([device readings](docs/wiki/device-readings-2026-10.md), [reels](docs/wiki/frontend/modules/reels.md)).
