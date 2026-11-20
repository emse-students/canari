## P2 - a salon reaction that opens its sender's new seed session is never notified while the app is open (2026-11-18)

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

**Seen on the Mi 9T, `1.7.0-alpha.10`, dev, 2026-11-18**
([device-verification](../device-verification.md#the-phone-readings-of-2026-11-18-170-alpha10-the-iphone-broadcasting-and-reactions-in-a-group-a-salon-and-a-locked-iphone)):
the first reaction of `delta`'s new seed session in a salon (the distribution epoch had just moved)
reached the Mi before its seed; the repair re-read it as history, which raises nothing, and the push
was dropped in the foreground - nothing was drawn.

**Built for `1.7.1`** ([mobile](../frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17)):
the live path parks a silent, repairable row's decision under its id (`owedLiveFrames.ts`), and the
history reader that opens that row takes it and raises the reaction live, once. Tests:
`channelEventHandler.reaction.test.ts`, `useConversations.owedLiveReaction.svelte.test.ts`.

**The reading owed (read on the next `1.7.1` pre-release, the Mi 9T on the feed):** remove then
re-add a member of a salon so the reactor's distribution epoch moves, then have the reactor react to
a line the Mi wrote there. ONE "a reagi" notification on `canari_reactions_v2`, and the WebView logs
`live row ... parked until its seed opens it` then `[NOTIF] Reaction to my message ... asking`. A
second reaction a minute later draws one too (the seed is held). None with the salon open.
