### Fixed - a reel is cut to its video, so its loop no longer shows a still frame over the sound

A camera take's audio started before its first frame and ran past its last one, which every loop showed
as a frozen picture; a reel is now prepared to the video track's own span
([reels](docs/wiki/frontend/modules/reels.md#the-end-of-a-reel-looked-frozen-2026-10-16)).
