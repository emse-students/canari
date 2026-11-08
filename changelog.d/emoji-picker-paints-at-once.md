### Fixed - the emoji picker's pictures appear at once instead of blank, growing in or showing a stray glyph

The first screen of the picker and its tab icons were lazy, asynchronously decoded and fetched only on the tap that opened it; they are now eager, boxed, warmed when a composer mounts, and a picture still on its way never shows its alt glyph. The iPhone reading is owed ([emoji](docs/wiki/frontend/emoji.md#the-picker-paints-at-once---2026-11-08)).
