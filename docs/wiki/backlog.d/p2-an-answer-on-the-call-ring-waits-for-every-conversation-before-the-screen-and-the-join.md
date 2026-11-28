## P2 - an answer on the call ring waited for every conversation's catch-up before the screen and the join (2026-11-28)

target: 1.8.4

**Built for 1.8.4 and tested in vitest, never run on a device - the reading below closes it** ([calls](../frontend/modules/calls.md#the-answer-joins-on-its-own-group-184-2026-11-28); owner decision of 2026-11-28). On the owner's Android 1.8.2, an answer on the ring of a resumed phone waited 10.7 s for the catch-up of every conversation before the call screen and the join; the screen now shows at once and the join waits only for the call's own group (its epoch at the server's, or drained), that group leading the drain.

**The reading, on the Mi 9T and the iPhone 12, on a pre-release carrying this:** with a backlog of other conversations' messages queued (the phone in the background a while, messages sent to it meanwhile), call it and answer on the native ring (app killed, and app in the background). Read in the exported log:

- `[CallAccept] timing: call screen shown (N ms after the native tap)` - the screen in about a second, before the conversation's messages finish;
- `[Call] timing: group ... current (<proof>) after N ms` - `epoch-reached` or `group-drained` in well under the drain's `[QUEUE] Drain complete` time, never `session-caught-up` with a `WARN ... NOT proven current`;
- `[CallAccept] timing: joined the room` and the `E2E proven` line's suffix against the 10.7 s + 2.3 s of 1.8.2;
- a hang-up on the connecting screen before the join: `the wait for group ... stopped`, no room token asked, the caller's ring ended.
