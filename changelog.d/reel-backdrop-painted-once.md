### Fixed - the reel backdrop is a smooth blur painted once, and no longer holes a recorded take

The area around a reel was a 24 px copy re-read from the video every 250 ms: blocky, stepping four times
a second, and costing ~25 ms a read, which on the Mi 9T dropped a third of the camera's frames
([reels](docs/wiki/frontend/modules/reels.md#the-backdrop-is-painted-once-2026-10-16)).
