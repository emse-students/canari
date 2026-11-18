## P2 - a salon reaction that opens its sender's new seed session is never notified while the app is open (2026-11-18)

target: 1.7.1

**Seen on the Mi 9T, `1.7.0-alpha.10`, dev, the sitting of 2026-11-18**
([device-verification](../device-verification.md#the-phone-readings-of-2026-11-18-170-alpha10-the-iphone-broadcasting-and-reactions-in-a-group-a-salon-and-a-locked-iphone)):
the Mi (`alpha`) on the feed, `delta` reacted to `alpha`'s line in a salon whose distribution epoch
had just moved, so the reaction was the FIRST frame of `delta`'s new seed session there. Nothing was
drawn. A second reaction a minute later, same salon, same seat, drew ONE notification - the trigger
of #3792 works once the seed is held.

**What the Mi logged, in order, within 60 ms:**

```
warning: [CHANNEL] Message <frame> of <salon> is unreadable and is not rendered - no seed for session <session> (repairable)
debug:   [GRAINE] seed <session> from <delta> for channel <salon> - v2 endorsement verified from the tree
debug:   [GRAINE] drain over - re-reading 1 salon(s) once for the seeds it brought
logcat:  onMessageReceived: type=social ... groupId=channel_<salon> ...
logcat:  App in foreground -> MLS handled by the foreground (WS), skip background processing
```

The bubble then showed the 👍 (the re-read applied it), and no `[NOTIF]` line was written for that
reaction at all.

**The mechanism, from the code.** `channelEventHandler.ts` raises `onInboundReaction` only after
`openChannelMessageProving` opened the frame; a frame without its seed returns before the reaction
branch, marked repairable. The seed lands in the drain that runs at the same moment, and the repair
(`releaseGraineRepairs` -> `deliverRepair`) re-reads the salon's history through `useConversations`,
"which raises nothing" - by design, since a history page must never announce a reaction (principle
of the trigger: live frames only). The push had meanwhile been dropped because the app was in the
foreground. So the one live frame is consumed by the unreadable path, and the repair that later
opens it is, by construction, not live: neither trigger draws it.

**Why it is not rare.** A seed session is new whenever the sender's distribution epoch moves - a
member removed or added, as in this salon - and the first frame after that is just as often a
reaction as a line. The line has its own unread path; the reaction has none.

**The fix to look at first** (not built): carry the "this frame arrived live" fact through the
repair. When a live frame is parked as repairable for a missing seed, record its id as owed a live
decision; when the repair opens that SAME frame, hand it to `onInboundReaction` with `live: true`
(only that id, only once, so a page of history still raises nothing). Test: a channel frame that
arrives before its seed, then the seed, raises one notification; the same frame read from a history
page raises none.

**Not a regression since `v1.6.12`**: the foreground trigger itself is new in `1.7.0` (#3792); before
it, no reaction raised anything in the foreground. Charter: principle 2 (the essential is never lost).
