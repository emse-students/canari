### Fixed - the front-lens photo matches the preview, and the shutter ring empties after a cancelled take

The saved photo and take were un-mirrored while the preview is mirrored, so the review looked inverted; they are now drawn as previewed. The ring is derived from the capture state, so no exit path leaves it full ([reels](docs/wiki/frontend/modules/reels.md#one-shutter-and-a-capture-that-is-the-preview-2026-10-05)).
