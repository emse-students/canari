## Reading owed - call noise suppression on a real call on both phones (the mechanical reads; the default stays OFF)

target: 1.7.0

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
| Mi 9T (WebView) | `noise suppression: worklet ready`, `[CALL_REPORT] ns=on`, the end line's `cost_ms_per_frame` / `realtime_pct`; **the route**: `adb shell dumpsys audio` before and after toggling ON - the mode stays `MODE_IN_COMMUNICATION` and the device (earpiece or speaker) does not move |
| iPhone 12 (WKWebView) | the same; or the `unavailable (<cause>)` WARN - a worklet scope without WebAssembly names itself; **the route**: with the switch ON, the earpiece and speaker still follow the speaker button, and CallKit's route is unchanged by the second AudioContext; `ns_fallbacks` across a lock |
| both | the switch turned on in a call answered from the native ring (`ns=pending` to the end = a context that never ran); a real voice and music with the switch on and off - the reading that decides the default; `enc_frames` still growing after a switch |

Also seen in the same run, unrelated to it: the gated `video-switch` and `video-off-on` rows read
19.6-25 fps (threshold 27) on Chrome 156 in two runs - the rig had not run since #2176 (it was
broken until this change), so when they started failing is unknown.

**Triage 2026-11-14 - left: the mechanical reads, both phones together, about 30 min** (a dev call between the phones, the switch ON: `worklet ready`, `ns=on`, `cost_ms_per_frame` / `realtime_pct`, `dumpsys audio` before and after, the iPhone route and `ns_fallbacks` across a lock, a call answered from the native ring). **DELETED: "a real voice and music with the switch on and off ... sounds good", the reading that would lift the default**: it needs an ear and a judgement, the bench has neither, and the owner decision of 2026-11-01 stands - RNNoise ships OFF, and the line above that names a sounds-good call as what lifts the default is now the OWNER's listening, not a bench reading: it is filed nowhere as owed. The `video-switch` and `video-off-on` fps finding is its own entry now ([rig rows](p3-the-gated-video-switch-and-video-off-on-rig-rows-read-19-6-25-fps-threshold-27.md)).

**Both phones, 2026-11-15 (Mi 9T `alpha`, iPhone 12 `gamma`, dev, `1.6.12-alpha.2`): the Mi mechanical reads PASS, the iPhone UI half PASS.** Worklet ready, `ns=on`, `cost_ms_per_frame` 1.169 / 1.325, `realtime_pct` 11.7 / 13.3, `ns_fallbacks=0`, `enc_frames` growing across switches, `dumpsys audio` mode and device unchanged, and a call answered from the native ring ended `ns=on` (never `pending`). iPhone: switch and speaker button, a lock of 12 s survived. **Left: the iPhone's `unavailable` WARN and `ns_fallbacks` (a store build has no console).** Detail: [device-verification](../device-verification.md#the-both-phones-readings-of-2026-11-15).

**2026-11-15, the owner's ears (hands-on sitting, a Mi 9T to iPhone 12 call of one minute with the switch ON):** "dans l'ensemble ca a l'air bien". That is the owner's listening, the human half the 2026-11-14 triage left to him; it does not lift the default (RNNoise stays OFF by the owner's decision of 2026-11-01) and is recorded in [device-verification](../device-verification.md#the-owners-hands-on-sitting-of-2026-11-15). **Left: the iPhone's `unavailable` WARN and `ns_fallbacks`, which a store build with no console cannot print.**

**iPhone 12, 2026-11-15 (`1.7.0-alpha.1`): the mechanics again PASS (switch ON, speaker, 12 s lock survived), the `unavailable` WARN and `ns_fallbacks` NOT READ** - the syslog carries no app console and the exported in-app log (24539 lines) cannot be searched over WDA ([readings](#the-iphone-12-readings-of-2026-11-15-170-alpha1-second-sitting)). **Left: those two console reads, which need a smaller export or an in-app viewer.**

**iPhone 12, 2026-11-16 (`1.7.0-alpha.2`): the console half is READ, and PASSES** through the persisted in-app log pulled over house_arrest (`bun tools/ios-device/applog.mjs`): two calls with the switch ON ended `ns=on ns_fallbacks=0` (cost 0.611 and 0.455 ms per frame), no `unavailable (` line anywhere in the ring. Nothing is left on the iPhone; the Mi 9T side was read earlier.

**Both phones, 2026-11-16 (`1.7.0-alpha.4`, dev, Mi 9T `alpha` dialling iPhone 12 `gamma`): `PASS` on both, again, with the Mi console and the iPhone's persisted log.** Mi: `worklet ready (context running)`, `ns=on` in the ticks after the switch, end line `ns=on ns_fallbacks=0 frames=3000 cost_ms_per_frame=1.323 realtime_pct=13.2`; `dumpsys audio` before and after the switch read `MODE_IN_COMMUNICATION` and the same earpiece; `MODE_NORMAL` after the hang-up. iPhone (`applog.mjs`): `worklet ready`, end `ns=on ns_fallbacks=0 frames=3500 cost_ms_per_frame=0.486 realtime_pct=4.9`, no `unavailable (` line in the ring. Every mechanical half is read and passes; what stays is the owner's listening (the default stays OFF by his decision). [readings](../device-verification.md#the-both-phones-readings-of-2026-11-16-on-170-alpha4)
