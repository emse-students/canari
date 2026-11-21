### Fixed - a voice note is recorded, no longer captured as a phone call

The recorder asked the microphone with echo cancellation, noise suppression and auto gain on, which made Android open it as a call and iOS put it through its voice-call processing; it now records like the reel camera, mono with no call processing, and keeps the call's own settings only while a call is live ([sounds](docs/wiki/frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20)).
