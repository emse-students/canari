### Fixed - a prepared video's sound no longer runs ahead of its picture

Chrome's audio decoder closed the holes of a phone's audio track, so a re-encoded video's sound ran
early by the sum of them, growing to the end; the holes are now restored as silence, and every video
is also resampled to a constant 30 fps ([video-preparation](docs/wiki/frontend/video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes)).
