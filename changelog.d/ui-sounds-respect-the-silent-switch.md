### Fixed - the app's sounds ignored the iPhone's silent switch and the Android ringer

The page now owns its audio session category: `ambient` for the app's tones, `playback` only while a media the reader unmuted plays, `play-and-record` during a call or any microphone capture; on Android an app tone plays only at the normal ringer mode ([sounds](docs/wiki/frontend/sounds.md#the-silent-switch-and-the-ringer-who-owns-the-category-owner-2026-11-04)).
