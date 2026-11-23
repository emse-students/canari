### Fixed - an Android call that replaces another in the call service gets its own audio focus

The replaced call's audio is closed and the new call opens its own, so its focus events carry its
id and a cellular call ending during it gives the microphone back
([calls](docs/wiki/frontend/modules/calls.md#a-call-behaves-like-a-phone-call-2026-10-30-after-the-owners-first-production-call)).
