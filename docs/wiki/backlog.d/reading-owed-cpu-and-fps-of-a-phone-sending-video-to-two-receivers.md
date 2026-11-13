## Reading owed - CPU and frame rate of a phone sending its camera to two receivers

target: 1.7.0

**What is built:** a three-way video group call sends the camera on one transceiver per leg, each
with its own quality ladder ([calls](../frontend/modules/calls.md#group-calls---the-mesh-client-half-wp-gc2-2026-11-13)).
The cap of 3 in video comes from a probe of 2026-10-16, not from the app
([group calls](group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md)).

**The reading that closes it:** the Mi 9T and the iPhone 12, each as a sender to two receivers for
five minutes on dev: each leg's `[CALL_REPORT]` (fps sent, the ladder's rung, `videoSendReduced`),
the phone's CPU (Android `top`, the iPhone's Xcode gauge) and its temperature; whether the cap of 3
holds or must come down.
