## P2 - Call noise suppression (RNNoise, D-B): built ON by default, its clean-speech rig row FAILS - the owner's call and the bench readings are owed (2026-10-31)

Built as decided ([calls](../frontend/modules/calls.md#noise-suppression-rnnoise---decided-2026-10-31-built-its-clean-speech-row-fails)),
but the gated rig row `app-ns` fails on the synthetic clean reference (LSD 11.0 dB against 7, HF
tilt -14.8 against -6, 1.3 s of dropouts against 0.25), while it lowers a steady background by
25 dB. What lifts it: either a real-voice reading on the phones showing the synthetic reference is
unfair to RNNoise (then the row's thresholds are re-read for a suppressor), or the default goes
OFF / another model (GTCRN, Speex) is measured on the same rows.

Owed on the bench, each read from the app log:

| Device | Read |
| --- | --- |
| Mi 9T (WebView) | `noise suppression: worklet ready`, `[CALL_REPORT] ns=on`, the end line's `cost_ms_per_frame` / `realtime_pct` |
| iPhone 12 (WKWebView) | the same; or the `unavailable (<cause>)` WARN - a worklet scope without WebAssembly names itself; the audio route (earpiece/speaker, CallKit) unchanged by the second AudioContext; `ns_fallbacks` across a lock |
| both | a call answered from the native ring (`ns=pending` all call = a context that never ran without a gesture); a real voice and music with the switch on and off; `enc_frames` still growing after a switch |

Also seen in the same run, unrelated to it: the gated `video-switch` and `video-off-on` rows read
19.6-25 fps (threshold 27) on Chrome 156 in two runs - the rig had not run since #2176 (it was
broken until this change), so when they started failing is unknown.
