## P2 - an answer on the call ring waited for every conversation's catch-up before the screen and the join (2026-11-28)

target: 1.8.4

**Built for 1.8.4 and tested in vitest, never run on a device - the reading below closes it** ([calls](../frontend/modules/calls.md#the-answer-joins-on-its-own-group-184-2026-11-28); owner decision of 2026-11-28). On the owner's Android 1.8.2, an answer on the ring of a resumed phone waited 10.7 s for the catch-up of every conversation before the call screen and the join; the screen now shows at once and the keys and the "answered" notice wait only for the call's own group at the server's epoch, that group leading the drain.

**The reading, on the Mi 9T and the iPhone 12, on a pre-release carrying this:** with a backlog of other conversations' messages queued (the phone in the background a while, messages sent to it meanwhile), call it and answer on the native ring (app killed, and app in the background). Read in the exported log:

- `[CallAccept] timing: call screen shown as full screen` (or `as banner` behind the PIN) - the screen in about a second, before the conversation's messages finish;
- `[Call] timing: group ... current (epoch-reached) after N ms` - in well under the drain's `[QUEUE] Drain complete` time, with no `WARN ... drained at epoch`, `AHEAD of the server` or `could not be read` line;
- `[CallAccept] timing: joined the room` and the `E2E proven` line's suffix against the 10.7 s + 2.3 s of 1.8.2;
- a hang-up on the connecting screen before the join: the screen closes at once, `hangup notice of ... held until its group is proven current` then the notice sent, the caller's call ended.
