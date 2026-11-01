## P2 - Call noise suppression (RNNoise, D-B): ships OFF by default (owner, 2026-11-01) - a real call on the bench phones decides when it goes ON

Built as decided ([calls](../frontend/modules/calls.md#noise-suppression-rnnoise---decided-2026-10-31-built-its-clean-speech-row-fails)),
but the gated rig row `app-ns` fails on the synthetic clean reference (LSD 11.0 dB against 7, HF
tilt -14.8 against -6, 1.3 s of dropouts against 0.25), while it lowers a steady background by
25 dB.

**Decided by the owner, 2026-11-01: RNNoise ships OFF by default**, the in-call switch kept
(`CALL_NOISE_SUPPRESSION_DEFAULT = false`; OFF builds no pipeline until the switch is turned on).
`[CALL_REPORT] ns=off` is the ordinary value from then on. **What lifts it to ON by default: a
real call on the bench phones that sounds good with the switch on** - and then the `app-ns`
thresholds are re-read for a suppressor, or another model (GTCRN, Speex) is measured on the same
rows if it does not.

Owed on the bench, each read from the app log of a call where the switch was turned ON:

| Device | Read |
| --- | --- |
| Mi 9T (WebView) | `noise suppression: worklet ready`, `[CALL_REPORT] ns=on`, the end line's `cost_ms_per_frame` / `realtime_pct` |
| iPhone 12 (WKWebView) | the same; or the `unavailable (<cause>)` WARN - a worklet scope without WebAssembly names itself; the audio route (earpiece/speaker, CallKit) unchanged by the second AudioContext; `ns_fallbacks` across a lock |
| both | the switch turned on in a call answered from the native ring (`ns=pending` to the end = a context that never ran); a real voice and music with the switch on and off - the reading that decides the default; `enc_frames` still growing after a switch |

Also seen in the same run, unrelated to it: the gated `video-switch` and `video-off-on` rows read
19.6-25 fps (threshold 27) on Chrome 156 in two runs - the rig had not run since #2176 (it was
broken until this change), so when they started failing is unknown.
