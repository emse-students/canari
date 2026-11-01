## P2 - The iPhone native ring (#2305): merged behind its switch, its Objective-C never compiled or run (2026-10-24)

`CALLS_NATIVE_RING_COMPILED`, `kCanariCallsEnabled` and the `voip` background mode stay off. The
Objective-C of `canari_push.mm` was written on Windows and is held only by a text test
(`nativeRingVoip.test.ts`). **Owed before the switch moves:** a compile on the iOS CI job, then the
K6/K7/K8 readings on the iPhone ([calls](../frontend/modules/calls.md#the-native-ring-on-the-iphone---pushkit-and-callkit-wp-c6-owner-2026-10-22)).
