### Fixed - CanaReels and full-screen videos show their seek line again

A video uploaded before its length was written into the file now learns it from its last segment
while it streams, so the progress line appears and can be dragged; until then the line follows what
is already loaded instead of vanishing ([video player](docs/wiki/frontend/modules/video-player.md#a-stream-learns-its-length-from-its-tail-2026-11-11)).
