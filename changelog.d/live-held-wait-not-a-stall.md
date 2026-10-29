### Fixed - a live viewer no longer seeks forward on a wait with media buffered ahead

A `waiting` with media ahead in the playhead's range is now the engine's own wait. It is left to end
by itself and checked again at the next delivery. The delivery line now prints every buffered range
([live](docs/wiki/frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27)).
