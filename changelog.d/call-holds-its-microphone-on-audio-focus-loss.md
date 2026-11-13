### Fixed - a phone call rung into an Android Canari call no longer leaves the microphone running

When another app takes the audio focus (a cellular call ringing in), the Canari call holds its
microphone and both ends are told; when the focus comes back the member's own mute state returns.
The call is never hung up ([calls](docs/wiki/frontend/modules/calls.md#a-call-behaves-like-a-phone-call-2026-10-30-after-the-owners-first-production-call)).
