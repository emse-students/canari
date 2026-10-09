### Fixed - the app no longer holds an audio output while nothing plays (looping noises on Android)

The notification tones' audio output stayed open for ever, frozen app included, and replayed its buffer when a push woke the app. It is now suspended when the last tone ends and closed when the app leaves the screen; background media is paused too ([sounds](docs/wiki/frontend/sounds.md)).
