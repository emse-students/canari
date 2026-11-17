### Measured - a live can go down to 1 Mb/s, through WebCodecs and not MediaRecorder

The Android ~2.5 Mb/s floor is `MediaRecorder`'s: in the same app WebView, WebCodecs H.264 delivers
about 1 Mb/s at 720p on the Mi 9T and the iPhone 12, at acceptable quality; H.264 stays the codec, AV1 is
out ([live-scaling](docs/wiki/frontend/modules/live-scaling.md#stage-0-ii---the-bitrate-floor-measured-2026-11-17)).
