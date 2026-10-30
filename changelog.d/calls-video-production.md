### Changed - 1:1 video calls are compiled into production builds

`CALLS_VIDEO_ENABLED` now follows `CALLS_ENABLED`, and the iPhone camera and microphone purpose
strings name video calls. Production stays closed until the server's `calls_mode` is
`audio_video`, opened after the video readings pass on both bench phones
([calls](docs/wiki/frontend/modules/calls.md#turning-video-on-in-production---11-video-in-152-owner-2026-10-30)).
