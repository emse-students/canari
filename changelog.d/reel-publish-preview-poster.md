### Fixed - the reel publish preview shows Canari's poster, not Android's grey play glyph, until its first frame

The 9:16 preview beside the caption had no `poster`, so the Android WebView drew its own placeholder right after a recording; it now reserves its box and carries the transparent poster under `VideoPoster`, like every other video ([reels](docs/wiki/frontend/modules/reels.md)).
