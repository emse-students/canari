### Fixed - a live viewer no longer seeks forward on a short wait with media buffered ahead

A `waiting` with media ahead in the playhead's range is now treated as the engine's own wait. If it
holds the picture for 500 ms or less, it is not a stall. The delivery line prints every buffered
range ([live](docs/wiki/frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27)).
