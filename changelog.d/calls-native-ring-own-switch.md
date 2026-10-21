### Changed - calls: the native ring is its own build switch, apart from in-app calls

`CALLS_NATIVE_RING_COMPILED` now carries `voip`, `USE_FULL_SCREEN_INTENT` and the two native ring constants, so `CALLS_COMPILED` can ship audio calls without the ring (owner, 2026-10-21); nothing flipped ([calls](docs/wiki/frontend/modules/calls.md#the-switches-agree-and-a-silent-frame-stays-unread)).
