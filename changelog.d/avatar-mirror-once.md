### Fixed - a salon open no longer rewrites every face in it to the notification cache

The Android avatar mirror writes the same bytes once per process instead of on every salon open, and sends them as base64 rather than a JSON number array (50 faces: 360-440 ms of main thread down to 130-150 ms on the Mi 9T, then nothing on a repeat) ([mobile](docs/wiki/frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)).
