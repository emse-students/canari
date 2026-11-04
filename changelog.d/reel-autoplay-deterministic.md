### Fixed - a CanaReel that did not start by itself until it was tapped

The reel player asks to play from `loadedmetadata` on, once per load; a refused autoplay shows the play button even before the first frame, and never mutes the sound the reader chose; an autoplay interrupted by a pause shows the play button instead of a frozen reel; a slow network shows a spinner, never the play button ([reels](docs/wiki/frontend/modules/reels.md#a-loading-reel-shows-its-first-frame-never-a-play-glyph-owner-2026-10-31)).
