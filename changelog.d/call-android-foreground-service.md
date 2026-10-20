### Added - an Android call keeps going when the app leaves the screen (dev builds)

A `microphone` foreground service with an ongoing `CallStyle` notification (name, timer, hang-up) holds the network, the microphone and the audio route while a call is up; it is merged only into builds that place calls, and `CALLS_COMPILED` stays false ([calls](docs/wiki/frontend/modules/calls.md#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20)).
