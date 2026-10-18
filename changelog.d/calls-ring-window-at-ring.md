### Fixed - a dev call's answer window opens when the callee starts ringing

The server's 60 s window now opens at the caller's ring, before the invite leaves, rather than at room creation; a late answer reads "this call is over", a refused ring "the call could not start", and the call relay never waits on a queue ([calls](docs/wiki/frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)).
