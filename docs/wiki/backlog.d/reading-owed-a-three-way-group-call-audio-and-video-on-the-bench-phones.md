## Reading owed - a three-way group call, audio and video, on the Mi 9T and the iPhone 12

target: 1.7.0

**What is built:** the client half of group calls - one leg per other participant, addressed
signalling, per-sender keys, the tile grid - behind `group_calls_mode = mesh` (dev only)
([calls](../frontend/modules/calls.md#group-calls---the-mesh-client-half-wp-gc2-2026-11-13)).

**The reading that closes it:** on dev, a three-way AUDIO call and a three-way VIDEO call between
the Mi 9T, the iPhone 12 and a desktop browser, each started once from each phone: every
participant hears and (video) sees the two others, the shield shows on every device, each log shows
one `[leg ...]` line set per other participant with `E2E path check ... PASS` on each leg, and a
leave closes only that leg (`leg closed`) until the last one, which ends the call. One member
declining while the two others talk changes nothing for them.
