### Changed - 1:1 video calls are compiled into production builds

`CALLS_VIDEO_ENABLED` now follows `CALLS_ENABLED`, and the iPhone camera and microphone purpose
strings name video calls. On Android a call's camera now turns off in the background and back on
at the return (it read only a visibility event the Android WebView never fires). Production stays closed until the server's `calls_mode` is
`audio_video`, opened after the video readings pass on both bench phones
([calls](docs/wiki/frontend/modules/calls.md#turning-video-on-in-production---11-video-in-152-owner-2026-10-30)).
