### Changed - in-app 1:1 audio calls are compiled into every build, held shut in production by the server switch

`CALLS_COMPILED` is on with the iOS `audio` mode, the Android microphone service and the microphone purpose string naming calls; the native ring, video and `calls_mode` (`off` at deploy) do not move. An iPhone without a VoIP token now gets a generic "Appel entrant" alert with no caller or conversation name. See [calls](docs/wiki/frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21).
