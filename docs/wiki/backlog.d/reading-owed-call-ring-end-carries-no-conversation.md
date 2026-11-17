## Reading owed - a ring's end no longer names the conversation, and still stops the ring (2026-11-17)

target: 1.7.0

**What is built:** the `call_ring_end` push (`CallsService.endRing`) carries `type`, `callId` and
`reason` only - no `groupId`, so Google and Apple no longer read which conversation a call was in
(content-free push WP-W6, owner decision N2 of 2026-11-04,
[content-free-push section 6](../protocols/content-free-push.md#6-calls---the-ring-stays-immediate)).
Proven by `calls.service.spec.ts` (the exact keys, `data` and APNs alike) and by the native
ring-end branches read as text (`androidCallRing.test.ts`, `callsCompiled.test.ts`); nothing native
has run it.

**The reading that closes it:** on a build carrying the server change (dev, any current app build -
no client changed), the Mi 9T and the iPhone 12 both LOCKED and rung by a 1:1 call from a third
seat; the caller hangs up before either answers. Both rings stop within a few seconds:
`adb logcat -s CanariFCM` shows `call_ring_end: call=<id> reason=cancelled` and the notification
goes; the iPhone's CallKit screen ends (`[CanariCallKit] call <id> ended`) and no ring alert is left
on the lock screen. The server logs `[ring] ring-end call=<id> notified=N/N`. A ring still showing
after the hang-up is a FAIL.
