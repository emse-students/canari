### Fixed - a CanaReel that did not start by itself until it was tapped

The reel player asks to play from `loadedmetadata` on, once per load; an audible autoplay the engine refuses is retried muted; an autoplay interrupted by a pause shows the play button instead of a frozen reel; a slow network shows a spinner, never the play button ([reels](docs/wiki/frontend/modules/reels.md#a-loading-reel-shows-its-first-frame-never-a-play-glyph-owner-2026-10-31)).
