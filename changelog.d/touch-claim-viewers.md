### Fixed - the reel viewer and the media lightbox no longer cancel a move the engine is scrolling

Both claim a drag through `claimTouchMove`, so the "Ignored attempt to cancel a touchmove event" line has no caller left ([reels](docs/wiki/frontend/modules/reels.md#read-end-to-end-on-both-phones-2026-10-02-main-at-4b62429e4-then-the-fixes-of-1354-and-1355)).
