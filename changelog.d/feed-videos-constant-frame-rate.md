### Changed - every uploaded video is a constant 30 fps

A variable-rate gallery clip (a phone that dropped frames) used to keep its irregular timestamps and
its holes; it is now resampled onto the Canari camera's 30 fps grid, the audio untouched. Measured
with a new A/V sync rig ([video-preparation](docs/wiki/frontend/video-preparation.md#constant-frame-rate)).
